class Heddle < Formula
  desc "Lightweight CLI agentic workflow framework"
  homepage "https://github.com/spichen/specrun"
  # url and sha256 are rewritten on every tagged release by
  # mislav/bump-homebrew-formula-action (see .github/workflows/release.yml).
  url "https://github.com/spichen/specrun/archive/refs/tags/v0.1.0-beta5.tar.gz"
  sha256 "8cc5a048a49a9db375ae547b89fb4134f81e209e628b74c182b639ca6ce4c21f"
  license "MIT"

  depends_on "node@20"
  depends_on "pnpm" => :build

  def install
    # The agentspec SDK is vendored in-tree (vendor/agentspec), so there is
    # nothing to fetch: `pnpm install` runs the root `prepare` script, which
    # builds it.
    system "pnpm", "install", "--frozen-lockfile"
    system "pnpm", "build"

    # `pnpm deploy` writes a self-contained tree for one workspace package,
    # with @heddle/core and the production dependencies resolved into a local
    # node_modules. --legacy is required because this workspace does not set
    # inject-workspace-packages.
    system "pnpm", "deploy", "--filter", "@heddle/cli", "--prod", "--legacy",
           buildpath/"deploy"

    libexec.install Dir[buildpath/"deploy/*"]

    (bin/"heddle").write <<~SH
      #!/bin/bash
      exec "#{Formula["node@20"].opt_bin}/node" "#{libexec}/dist/heddle.js" "$@"
    SH
    chmod 0755, bin/"heddle"
  end

  test do
    assert_match "Usage:", shell_output("#{bin}/heddle --help")

    (testpath/"flow.yaml").write <<~YAML
      component_type: Flow
      name: smoke-flow
      start_node:
        $component_ref: start
      nodes:
        - $component_ref: start
        - $component_ref: end
      control_flow_connections:
        - component_type: ControlFlowEdge
          name: start_to_end
          from_node: { $component_ref: start }
          to_node: { $component_ref: end }
      $referenced_components:
        start:
          component_type: StartNode
          id: start
          name: start
        end:
          component_type: EndNode
          id: end
          name: end
    YAML
    assert_match "Valid:", shell_output("#{bin}/heddle validate #{testpath}/flow.yaml")
  end
end
