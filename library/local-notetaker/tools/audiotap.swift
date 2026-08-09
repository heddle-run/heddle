// audiotap — capture this machine's audio output with a Core Audio process tap.
//
// Writes interleaved float32 PCM to stdout and one line to stderr first:
//
//     FORMAT sampleRate=48000 channels=1
//
// so the caller can configure a decoder without guessing. Ends cleanly on
// SIGINT, which is how a meeting recording is meant to stop.
//
// Why a tap rather than a virtual audio driver: macOS does not let an
// application record system output, and the usual answer is to install a
// loopback driver (BlackHole) and hand-build Multi-Output and Aggregate devices
// in Audio MIDI Setup. That needs an admin password, a reboot, and GUI steps no
// installer can do for you. Core Audio taps (macOS 14.2+) do the same job with
// none of it: no driver, no reboot, no rerouting of the user's output, and the
// aggregate device is created here in code rather than by hand.
//
// Build:  swiftc -O audiotap.swift -o audiotap

import AVFoundation
import CoreAudio
import Darwin

// MARK: - Core Audio helpers

func property<T>(_ object: AudioObjectID, _ selector: AudioObjectPropertySelector, _ initial: T) -> T? {
    var address = AudioObjectPropertyAddress(
        mSelector: selector,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var value = initial
    var size = UInt32(MemoryLayout<T>.size)
    let status = withUnsafeMutablePointer(to: &value) {
        AudioObjectGetPropertyData(object, &address, 0, nil, &size, $0)
    }
    return status == noErr ? value : nil
}

func die(_ message: String) -> Never {
    FileHandle.standardError.write(Data("audiotap: \(message)\n".utf8))
    exit(1)
}

/// The device the system is currently playing through — the one worth tapping.
func defaultOutputDevice() -> AudioObjectID {
    guard let id = property(
        AudioObjectID(kAudioObjectSystemObject),
        kAudioHardwarePropertyDefaultSystemOutputDevice,
        AudioObjectID(0)
    ), id != 0 else {
        die("no default output device")
    }
    return id
}

func deviceUID(_ device: AudioObjectID) -> String {
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceUID,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain)
    var uid: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    let status = withUnsafeMutablePointer(to: &uid) {
        AudioObjectGetPropertyData(device, &address, 0, nil, &size, $0)
    }
    if status != noErr { die("could not read the output device UID (\(status))") }
    return uid as String
}

// MARK: - Tap

// A global tap: everything the machine plays, minus nothing. `.unmuted` is
// load-bearing — the other mute behaviours silence the output while tapping,
// which would mean recording a meeting you can no longer hear.
let tapDescription = CATapDescription(monoGlobalTapButExcludeProcesses: [])
tapDescription.uuid = UUID()
tapDescription.muteBehavior = .unmuted
tapDescription.name = "heddle-local-notetaker"
tapDescription.isPrivate = true

var tapID = AudioObjectID(kAudioObjectUnknown)
let tapStatus = AudioHardwareCreateProcessTap(tapDescription, &tapID)
if tapStatus != noErr || tapID == kAudioObjectUnknown {
    die("could not create the audio tap (\(tapStatus)). macOS 14.2+ is required, "
        + "and the terminal running this needs audio-recording permission in "
        + "System Settings > Privacy & Security")
}

// MARK: - Aggregate device carrying the tap

let outputUID = deviceUID(defaultOutputDevice())
let aggregateUID = UUID().uuidString

let aggregateDescription: [String: Any] = [
    kAudioAggregateDeviceNameKey as String: "heddle-tap",
    kAudioAggregateDeviceUIDKey as String: aggregateUID,
    // Private: it belongs to this process and never appears in the user's
    // sound settings, so a crashed run cannot leave a stray device behind.
    kAudioAggregateDeviceIsPrivateKey as String: true,
    kAudioAggregateDeviceIsStackedKey as String: false,
    kAudioAggregateDeviceTapAutoStartKey as String: true,
    kAudioAggregateDeviceSubDeviceListKey as String: [
        [kAudioSubDeviceUIDKey as String: outputUID]
    ],
    kAudioAggregateDeviceTapListKey as String: [
        [
            kAudioSubTapDriftCompensationKey as String: true,
            kAudioSubTapUIDKey as String: tapDescription.uuid.uuidString,
        ]
    ],
]

var aggregateID = AudioObjectID(kAudioObjectUnknown)
let aggregateStatus = AudioHardwareCreateAggregateDevice(
    aggregateDescription as CFDictionary, &aggregateID)
if aggregateStatus != noErr || aggregateID == kAudioObjectUnknown {
    die("could not create the aggregate device (\(aggregateStatus))")
}

func teardown() {
    if aggregateID != kAudioObjectUnknown { AudioHardwareDestroyAggregateDevice(aggregateID) }
    if tapID != kAudioObjectUnknown { AudioHardwareDestroyProcessTap(tapID) }
}

// MARK: - Format

var formatAddress = AudioObjectPropertyAddress(
    mSelector: kAudioTapPropertyFormat,
    mScope: kAudioObjectPropertyScopeGlobal,
    mElement: kAudioObjectPropertyElementMain)
var streamDescription = AudioStreamBasicDescription()
var formatSize = UInt32(MemoryLayout<AudioStreamBasicDescription>.size)
if AudioObjectGetPropertyData(tapID, &formatAddress, 0, nil, &formatSize, &streamDescription) != noErr {
    teardown()
    die("could not read the tap's audio format")
}

let sampleRate = Int(streamDescription.mSampleRate)
let channels = Int(streamDescription.mChannelsPerFrame)
FileHandle.standardError.write(
    Data("FORMAT sampleRate=\(sampleRate) channels=\(channels)\n".utf8))

// MARK: - Capture

// Written from the IO block, read after the run loop stops.
var ioProcID: AudioDeviceIOProcID?
let stdoutDescriptor: Int32 = 1

let status = AudioDeviceCreateIOProcIDWithBlock(&ioProcID, aggregateID, nil) {
    _, inInputData, _, _, _ in
    let buffers = UnsafeMutableAudioBufferListPointer(
        UnsafeMutablePointer(mutating: inInputData))
    for buffer in buffers {
        guard let data = buffer.mData, buffer.mDataByteSize > 0 else { continue }
        var offset = 0
        let total = Int(buffer.mDataByteSize)
        // write(2) can return short; a partial frame would desynchronise the
        // decoder downstream, so loop until the block is out.
        while offset < total {
            let written = write(stdoutDescriptor, data.advanced(by: offset), total - offset)
            if written <= 0 { return }
            offset += written
        }
    }
}
if status != noErr || ioProcID == nil {
    teardown()
    die("could not install the IO proc (\(status))")
}

signal(SIGINT) { _ in stop() }
signal(SIGTERM) { _ in stop() }

func stop() {
    if let proc = ioProcID {
        AudioDeviceStop(aggregateID, proc)
        AudioDeviceDestroyIOProcID(aggregateID, proc)
    }
    teardown()
    exit(0)
}

if AudioDeviceStart(aggregateID, ioProcID) != noErr {
    teardown()
    die("could not start the aggregate device")
}

// The IO block runs on Core Audio's own thread; this one only waits.
CFRunLoopRun()
