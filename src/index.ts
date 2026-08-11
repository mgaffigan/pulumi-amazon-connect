/**
 * Author Amazon Connect contact flows as composable TypeScript.
 *
 * A flow is an ordinary function. The actions it calls are free functions that record into an
 * ambient context, so a fragment imported from another module or package composes with no wiring:
 *
 * ```ts
 * import { play, flowIf, attr, transferToQueue } from "pulumi-amazon-connect";
 * import { authenticateCaller } from "@acme/connect-patterns";
 *
 * export function inbound() {
 *   play("Thanks for calling.");
 *   const account = authenticateCaller({ maxAttempts: 3 });
 *   flowIf({ op: "equals", left: attr("tier"), right: "gold" }, {
 *     ifTrue: () => transferToQueue({ queue: vipQueueArn }),
 *     ifFalse: () => transferToQueue({ queue: mainQueueArn }),
 *   });
 * }
 * ```
 *
 * Recording is synchronous: the flow is a description, not a run. Build-time work — an AWS lookup, a
 * file read — happens before the flow, and a fragment that returns a promise is rejected rather than
 * silently recorded out of order.
 *
 * Three limits of the flow language shape this API, and no library can paper over them:
 * comparisons are unary against a *static* operand, there is no arithmetic, and a flow may hold at
 * most 250 actions. Anything that needs real computation belongs in a Lambda.
 */

// Actions.
export type { OutcomeHandler, Text } from "./flow/actions/action.js";
export {
  type AttributeValue,
  type SetAttributesOptions,
  setAttributes,
  setFlowAttributes,
} from "./flow/actions/attributes.js";
export {
  type CheckQueueMetricOptions,
  type CheckStaffingOptions,
  checkHoursOfOperation,
  checkQueueMetric,
  checkStaffing,
  type DistributeOptions,
  type DistributionBranch,
  flowDistribute,
  type GetMetricDataOptions,
  getMetricData,
  type HoursOfOperationOptions,
  type MetricBranch,
  type QueueMetric,
  type StaffingMetric,
} from "./flow/actions/checks.js";
export {
  type AnalyticsOptions,
  type AttributeRequirement,
  type CallbackContactOptions,
  type CallbackNumberOptions,
  type ChatAnalyticsMode,
  type ContactDataOptions,
  type ContactEvent,
  type CreateTaskOptions,
  createCallbackContact,
  createTask,
  createWisdomSession,
  type MediaDirection,
  type MediaProcessingOptions,
  type MediaStreamingOptions,
  type ProficiencyLevel,
  type RecordedParticipant,
  type RecordingAnalyticsOptions,
  type RecordingAndAnalyticsOptions,
  type RecordingOptions,
  type RoutingBehaviorOptions,
  type RoutingStep,
  resumeContact,
  setCallbackNumber,
  setContactData,
  setEventFlow,
  setMediaProcessing,
  setPreviousParticipantState,
  setRecordingAndAnalytics,
  setRecordingBehavior,
  setRoutingBehavior,
  setRoutingCriteria,
  setVoice,
  startMediaStreaming,
  stopMediaStreaming,
  type TextToSpeechEngine,
  type TextToSpeechStyle,
  tagContact,
  untagContact,
  type VoiceAnalyticsMode,
  type VoiceIdSettings,
  type VoiceOptions,
} from "./flow/actions/contact.js";
export {
  type ShowViewOptions,
  setLogging,
  showView,
  type ViewResultHandler,
  type WaitEvent,
  type WaitOptions,
  type WaitWithContinueOptions,
  wait,
} from "./flow/actions/misc.js";
export {
  type EndFlowModuleOptions,
  endFlowModule,
  type InvokeFlowModuleOptions,
  invokeFlowModule,
  type ModuleResultHandler,
  type ModuleValue,
} from "./flow/actions/modules.js";
export {
  type CompleteOutboundCallOptions,
  checkOutboundCallStatus,
  completeOutboundCall,
  type OutboundCallStatusOptions,
  type OutboundChatOptions,
  startOutboundChat,
  type VoiceConnector,
} from "./flow/actions/outbound.js";
export {
  type CollectInputOptions,
  collectInput,
  connectToLexBot,
  type DtmfConfiguration,
  type DtmfKey,
  type DtmfOptions,
  disconnect,
  endFlow,
  getDigit,
  type InputEncryption,
  type IterativeMessage,
  type LexBot,
  type LexOptions,
  type MediaSource,
  type PlayIterativelyOptions,
  type PlayOptions,
  play,
  playIteratively,
} from "./flow/actions/participant.js";
export {
  dequeueAndTransferToQueue,
  type QueueTarget,
  type SetQueueOptions,
  setQueue,
  type ThirdPartyOptions,
  type TransferToQueueOptions,
  transferToAgent,
  transferToFlow,
  transferToQueue,
  transferToThirdParty,
} from "./flow/actions/routing.js";
export {
  type CheckVoiceIdOptions,
  checkVoiceId,
  type EnrollmentStatusOptions,
  type FraudDetectionOptions,
  startVoiceIdStream,
  type VoiceAuthenticationOptions,
} from "./flow/actions/voiceid.js";
// Control flow.
export {
  type Branches,
  type Comparison,
  type EqualityOp,
  flowIf,
  flowLoop,
  flowSwitch,
  goto,
  type KeyComparison,
  type KeyOp,
  label,
  type NumberOp,
  type OperatorFor,
  onError,
  type SwitchOptions,
  type TextOp,
  type ValueComparison,
} from "./flow/control.js";
// Wire types and validation, for tooling built on top of this library.
export { type EmitResult, emitFlow, toIdentifier } from "./flow/emit.js";
export {
  jsonSchemaFor,
  MAX_MODULE_BRANCHES,
  type ModuleBranch,
  type ModuleContract,
  type ModuleData,
  type ModuleFieldType,
  type ModuleInput,
  type ModuleSchema,
  moduleSettingsJson,
} from "./flow/moduleContract.js";
// Recording context, for fragment authors and tooling.
export {
  type Block,
  currentRecorder,
  type FlowFragment,
  Label,
  type Recorder,
  type RunRecorderOptions,
  runRecorder,
  type TerminalAction,
  withScope,
} from "./flow/recorder.js";
// Values and references.
export {
  assertValidAttributeKey,
  attr,
  type Dynamic,
  external,
  flowAttr,
  isRef,
  MODULE_INPUT_ROOT,
  MODULE_RESULT_ROOT,
  type ModuleRefs,
  makeRef,
  moduleInputRefs,
  moduleResultRefs,
  type Ref,
  type ResourceRef,
  renderResource,
  renderValue,
  segmentAttr,
  system,
  VIEW_ACTION_PATH,
  VIEW_RESULT_ROOT,
  type ViewRefs,
  type ViewResult,
  type ViewTable,
  viewRefs,
} from "./flow/refs.js";
export {
  type Condition,
  type ConditionOperator,
  FLOW_VERSION,
  type FlowAction,
  type FlowJson,
  isValidIdentifier,
  MAX_ACTIONS_PER_FLOW,
  NO_MATCHING_CONDITION,
  NO_MATCHING_ERROR,
  type Transitions,
} from "./flow/types.js";
export { FlowValidationError, findProblems, validateFlow } from "./flow/validate.js";
export {
  type AsyncConnectLambda,
  type AsyncLambdaOptions,
  type ConnectHandler,
  type ConnectLambda,
  connectLambda,
  type DynamicInput,
  type ExternalRefs,
  type InvocationInput,
  type InvocationTimeout,
  type InvokeOptions,
  type JsonLambdaOptions,
  type StringMap,
  type StringMapLambdaOptions,
} from "./lambda/connectLambda.js";
// Lambdas.
export type {
  ContactData,
  ContactFlowEvent,
  ContactReference,
  Endpoint,
  InitiationMethod,
  MediaStream,
  QueueInfo,
  SegmentAttributeValue,
} from "./lambda/event.js";
export { ConnectView, type ConnectViewArgs } from "./pulumi/ConnectView.js";
// Deployment.
export { ContactFlow, type ContactFlowArgs, type ContactFlowType } from "./pulumi/ContactFlow.js";
export {
  ContactFlowModule,
  type ContactFlowModuleArgs,
  type InvokeArgs,
  type ModuleBody,
  type NoFields,
} from "./pulumi/ContactFlowModule.js";
// The views Connect ships in every instance, as typed declarations rather than templates.
export {
  type ActionSelectedResult,
  type AfterContactWorkViewActions,
  type AfterContactWorkViewInputs,
  type AfterContactWorkViewResult,
  type AwsManagedViewOptions,
  awsAfterContactWorkView,
  awsCardsView,
  awsConfirmationView,
  awsDetailView,
  awsFormView,
  awsListView,
  awsManagedViewArn,
  type CardsViewActions,
  type CardsViewInputs,
  type ConfirmationViewInputs,
  type ConfirmationViewResult,
  type DetailViewActions,
  type DetailViewInputs,
  type FormViewActions,
  type FormViewInputs,
  type FormViewResult,
  type ListViewActions,
  type ListViewInputs,
  type ManagedAction,
  type ManagedAttribute,
  type ManagedAttributeSection,
  type ManagedCard,
  type ManagedCardDetail,
  type ManagedCardSummary,
  type ManagedDataItem,
  type ManagedFormField,
  type ManagedFormSection,
  type ManagedListItem,
  type ManagedSectionContent,
  type ManagedWizardStep,
  type TemplateString,
} from "./view/awsManagedViews.js";
export {
  Alert,
  type AlertLevel,
  type AlertType,
  Application,
  Attribute,
  AttributeBar,
  type AttributeItem,
  AttributeSection,
  Button,
  ButtonGroup,
  type ButtonGroupItem,
  type ButtonOptions,
  type ButtonOrientation,
  type ButtonVariant,
  Card,
  CheckboxGroup,
  Column,
  type ColumnSpan,
  type ColumnWidth,
  Container,
  DatePicker,
  Dropdown,
  type FontSize,
  type FontWeight,
  Form,
  type FormAction,
  FormInput,
  GroupButton,
  Header,
  type HeaderVariant,
  Icon,
  type IconAlign,
  type IconVariant,
  Image,
  type InputType,
  type ItemChildren,
  isViewItemNode,
  Link,
  type LinkType,
  Loader,
  RadioGroup,
  Section,
  type SelectOption,
  type Spacing,
  SubmitButton,
  Table,
  type TableColumn,
  type TableColumnType,
  type TableEditableType,
  type TableOptions,
  type TableRow,
  type TableRowConfiguration,
  type TextAlign,
  TextArea,
  TextBox,
  type TextBoxOptions,
  type TextContent,
  type TextVariant,
  TimePicker,
  Toggle,
  type ViewChild,
  type ViewConfiguration,
  type ViewItemNode,
  type ViewLayout,
  type ViewNode,
  type ViewValue,
} from "./view/components.js";
// Views.
export {
  type ExistingViewFromDefinition,
  type ExistingViewOptions,
  existingView,
  type Shape,
  type ShowArgs,
  type ShowableView,
  shape,
  type ViewActionHandler,
  type ViewInput,
  type ViewOutput,
} from "./view/connectView.js";
// Typed input references, so a view's `$.` strings come from a declared type.
export {
  type FieldRefs,
  fieldRefs,
  type InputRef,
  type InputRefs,
  inputRefs,
  ref,
  type ViewInputs,
} from "./view/inputs.js";
// JSX support. The factory itself is reached through the `pulumi-amazon-connect/jsx-runtime` subpath,
// which is what `jsxImportSource` resolves to; these are here for tooling and tests.
export { CONTENT_FIRST, Fragment, jsx, jsxs, type ViewComponent } from "./view/jsx-runtime.js";
export {
  type DefinedView,
  type DefineViewOptions,
  defineView,
  toViewInputContent,
  type ViewContent,
  type ViewContext,
  type ViewHead,
  type ViewTemplate,
} from "./view/template.js";
