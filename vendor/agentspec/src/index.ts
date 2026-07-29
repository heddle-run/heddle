/**
 * agentspec - TypeScript SDK for the Oracle Open Agent Specification.
 *
 * Public API barrel export.
 */

// Versioning
export {
  AgentSpecVersion,
  CURRENT_VERSION,
  AGENTSPEC_VERSION_FIELD_NAME,
  LEGACY_AGENTSPEC_VERSIONS,
  versionLt,
  versionGte,
  versionMax,
} from "./versioning.js";

// Property system
export {
  PropertySchema,
  stringProperty,
  booleanProperty,
  integerProperty,
  numberProperty,
  nullProperty,
  unionProperty,
  listProperty,
  dictProperty,
  objectProperty,
  propertyFromJsonSchema,
  propertiesHaveSameType,
  propertyIsCastableTo,
  deduplicatePropertiesByTitleAndType,
  type Property,
  type JsonSchemaValue,
} from "./property.js";

// Base component types
export {
  ComponentBaseSchema,
  ComponentWithIOSchema,
  isComponent,
  type ComponentBase,
  type ComponentWithIO,
  type AbstractComponentType,
  type ComponentTypeName,
} from "./component.js";

// Templating
export {
  TEMPLATE_PLACEHOLDER_REGEXP,
  getPlaceholdersFromString,
  getPlaceholdersFromJsonObject,
  getPlaceholderPropertiesFromJsonObject,
} from "./templating.js";

// Sensitive field handling
export { SENSITIVE_FIELDS, isSensitiveField } from "./sensitive-field.js";

// LLM configs
export {
  LlmConfigUnion,
  LlmGenerationConfigSchema,
  OpenAIAPIType,
  type LlmConfig,
  type LlmGenerationConfig,
  OpenAiCompatibleConfigSchema,
  createOpenAiCompatibleConfig,
  type OpenAiCompatibleConfig,
  OllamaConfigSchema,
  createOllamaConfig,
  type OllamaConfig,
  VllmConfigSchema,
  createVllmConfig,
  type VllmConfig,
  OpenAiConfigSchema,
  createOpenAiConfig,
  type OpenAiConfig,
  OciGenAiConfigSchema,
  createOciGenAiConfig,
  ServingMode,
  ModelProvider,
  OciAPIType,
  type OciGenAiConfig,
  OciClientConfigUnion,
  OciClientConfigWithApiKeySchema,
  OciClientConfigWithInstancePrincipalSchema,
  OciClientConfigWithResourcePrincipalSchema,
  OciClientConfigWithSecurityTokenSchema,
  createOciClientConfigWithApiKey,
  createOciClientConfigWithInstancePrincipal,
  createOciClientConfigWithResourcePrincipal,
  createOciClientConfigWithSecurityToken,
  type OciClientConfig,
  type OciClientConfigWithApiKey,
  type OciClientConfigWithInstancePrincipal,
  type OciClientConfigWithResourcePrincipal,
  type OciClientConfigWithSecurityToken,
} from "./llms/index.js";

// Tools
export {
  ToolUnion,
  ToolBaseSchema,
  type Tool,
  type ToolBase,
  ServerToolSchema,
  createServerTool,
  type ServerTool,
  ClientToolSchema,
  createClientTool,
  type ClientTool,
  RemoteToolSchema,
  createRemoteTool,
  type RemoteTool,
  BuiltinToolSchema,
  createBuiltinTool,
  type BuiltinTool,
  ToolBoxUnion,
  MCPToolBoxSchema,
  createMCPToolBox,
  type ToolBox,
  type MCPToolBox,
} from "./tools/index.js";

// MCP
export {
  ClientTransportUnion,
  StdioTransportSchema,
  SSETransportSchema,
  SSEmTLSTransportSchema,
  StreamableHTTPTransportSchema,
  StreamableHTTPmTLSTransportSchema,
  RemoteTransportSchema,
  createStdioTransport,
  createSSETransport,
  createSSEmTLSTransport,
  createStreamableHTTPTransport,
  createStreamableHTTPmTLSTransport,
  createRemoteTransport,
  type ClientTransport,
  type StdioTransport,
  type SSETransport,
  type SSEmTLSTransport,
  type StreamableHTTPTransport,
  type StreamableHTTPmTLSTransport,
  type RemoteTransport,
  MCPToolSchema,
  MCPToolSpecSchema,
  createMCPTool,
  createMCPToolSpec,
  type MCPTool,
  type MCPToolSpec,
} from "./mcp/index.js";

// Agents
export {
  AgenticComponentUnion,
  type AgenticComponent,
  AgentSchema,
  createAgent,
  type Agent,
  SwarmSchema,
  createSwarm,
  HandoffMode,
  type Swarm,
  ManagerWorkersSchema,
  createManagerWorkers,
  type ManagerWorkers,
  RemoteAgentSchema,
  createRemoteAgent,
  type RemoteAgent,
  A2AAgentSchema,
  A2AConnectionConfigSchema,
  createA2AAgent,
  createA2AConnectionConfig,
  type A2AAgent,
  type A2AConnectionConfig,
  SpecializedAgentSchema,
  AgentSpecializationParametersSchema,
  createSpecializedAgent,
  createAgentSpecializationParameters,
  type SpecializedAgent,
  type AgentSpecializationParameters,
} from "./agents/index.js";

// Flows
export {
  DEFAULT_NEXT_BRANCH,
  NodeBaseSchema,
  type NodeBase,
  NodeUnion,
  type Node,
  StartNodeSchema,
  createStartNode,
  type StartNode,
  EndNodeSchema,
  createEndNode,
  type EndNode,
  LlmNodeSchema,
  createLlmNode,
  DEFAULT_LLM_OUTPUT,
  type LlmNode,
  ToolNodeSchema,
  createToolNode,
  type ToolNode,
  AgentNodeSchema,
  createAgentNode,
  type AgentNode,
  FlowNodeSchema,
  createFlowNode,
  type FlowNode,
  BranchingNodeSchema,
  createBranchingNode,
  DEFAULT_BRANCH,
  DEFAULT_INPUT,
  type BranchingNode,
  MapNodeSchema,
  createMapNode,
  ReductionMethod,
  type MapNode,
  ParallelMapNodeSchema,
  createParallelMapNode,
  type ParallelMapNode,
  ParallelFlowNodeSchema,
  createParallelFlowNode,
  type ParallelFlowNode,
  ApiNodeSchema,
  createApiNode,
  DEFAULT_API_OUTPUT,
  type ApiNode,
  InputMessageNodeSchema,
  createInputMessageNode,
  DEFAULT_INPUT_MESSAGE_OUTPUT,
  type InputMessageNode,
  OutputMessageNodeSchema,
  createOutputMessageNode,
  type OutputMessageNode,
  CatchExceptionNodeSchema,
  createCatchExceptionNode,
  CAUGHT_EXCEPTION_BRANCH,
  DEFAULT_EXCEPTION_INFO_VALUE,
  type CatchExceptionNode,
  ControlFlowEdgeSchema,
  createControlFlowEdge,
  type ControlFlowEdge,
  DataFlowEdgeSchema,
  createDataFlowEdge,
  type DataFlowEdge,
  FlowSchema,
  createFlow,
  type Flow,
  FlowBuilder,
} from "./flows/index.js";

// Schema registration — heddle local modification, patch 1 (see VENDOR.md).
//
// `NodeUnion` is a closed discriminated union, so a runtime that defines its own
// node types has no way to get one past `FlowSchema.parse`: the flow is rejected
// on structure before any deserialization plugin is consulted, and the plugin
// system upstream ships is unreachable for exactly the components it exists to
// carry. These two functions are the seam the SDK already uses on itself —
// `nodes/index.ts` and `flow.ts` call them at module load to break the
// flow/node import cycle — and they rebind the schemas that `LazyNodeRef` and
// `LazyFlowRef` resolve to at parse time. Exporting them lets a host register a
// widened union instead of substituting a builtin node and swapping the real one
// back afterwards.
//
// Both are needed, not just the node one: `LazyNodeRef` backs `Flow.nodes`,
// `Flow.startNode` and both edge endpoints, while `LazyFlowRef` backs every
// subflow position (`FlowNode`, `MapNode`, `CatchExceptionNode`, the parallel
// pair). A host that rebinds one and not the other gets a widened top-level flow
// whose subflows still validate against the original union.
export {
  registerMessageTransformSchema,
} from "./transforms/lazy-schemas.js";

export {
  registerNodeUnionSchema,
  registerFlowSchema,
} from "./flows/lazy-schemas.js";

// Datastores
export {
  InMemoryCollectionDatastoreSchema,
  createInMemoryCollectionDatastore,
  type InMemoryCollectionDatastore,
  OracleDatabaseDatastoreSchema,
  TlsOracleDatabaseConnectionConfigSchema,
  MTlsOracleDatabaseConnectionConfigSchema,
  createOracleDatabaseDatastore,
  createTlsOracleDatabaseConnectionConfig,
  createMTlsOracleDatabaseConnectionConfig,
  type OracleDatabaseDatastore,
  type TlsOracleDatabaseConnectionConfig,
  type MTlsOracleDatabaseConnectionConfig,
  PostgresDatabaseDatastoreSchema,
  TlsPostgresDatabaseConnectionConfigSchema,
  createPostgresDatabaseDatastore,
  createTlsPostgresDatabaseConnectionConfig,
  type PostgresDatabaseDatastore,
  type TlsPostgresDatabaseConnectionConfig,
} from "./datastores/index.js";

// Transforms
export {
  MessageSummarizationTransformSchema,
  ConversationSummarizationTransformSchema,
  MessageTransformUnion,
  createMessageSummarizationTransform,
  createConversationSummarizationTransform,
  type MessageSummarizationTransform,
  type ConversationSummarizationTransform,
  type MessageTransform,
} from "./transforms/index.js";

// Component registry
export {
  BUILTIN_SCHEMA_MAP,
  BUILTIN_FACTORY_MAP,
  getSchemaForComponentType,
  isBuiltinComponentType,
  getComponentFactory,
} from "./component-registry.js";

// Serialization
export {
  AgentSpecSerializer,
  AgentSpecDeserializer,
  SerializationContext,
  DeserializationContext,
  camelToSnake,
  snakeToCamel,
  computeReferencingStructure,
  VERSION_GATED_FIELDS,
  type ComponentSerializationPlugin,
  type ComponentDeserializationPlugin,
  type ComponentsRegistry,
} from "./serialization/index.js";
