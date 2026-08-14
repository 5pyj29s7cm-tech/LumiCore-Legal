import { ToolRegistry } from '../registry';
import { registerFileOpsTools } from './file_ops';
import { registerSystemOpsTools } from './system_ops';
import { registerWebOpsTools } from './web_tools';
import { registerWebLoginTools } from './web_login_tools';
import { registerCodeOpsTools } from './code_tools';
import { registerDataOpsTools } from './data_tools';
import { registerDesktopTools } from './desktop_tools';
import { registerGitTools } from './git_tools';
import { registerVerifyTools } from './verify_tools';
import { registerSkillTools, setSkillLLMGetters } from './skill_tools';
import { registerOfficeTools } from './office_tools';
import { registerCalendarTools } from './calendar_tools';
import { registerAgentTools } from './agent_tools';
import { registerScreenMonitorTools } from './screen_monitor';
import { registerClipboardTools } from './clipboard_tools';
import { registerOCRTools } from './ocr_tools';
import { registerPdfTools } from './pdf_tools';
import { registerDocumentTools } from './document_tools';
import { registerKnowledgeTools } from './knowledge_tools';
import { registerWorkflowTools } from './workflow_tools';
import { registerImageTools } from './image_tools';
import { registerVideoTools } from './video_tools';
import { registerInputTools } from './input_tools';
import { registerComputerUseTool } from './computer_use_tool';
import { registerPythonTools } from './python_tools';
import { registerBiometricTools } from './biometric_tools';
import { registerLegalTools } from './legal_tools';
import { registerClientSelfTools } from './client_self_tools';
import { registerExternalAppTools } from './external_app_tools';
import { registerExternalControlTools } from './external_control_tools';
import { registerAutonomyTools } from './autonomy_tools';
import { registerCapabilityResearchTools } from './capability_research_tools';
import { registerSleepTools } from './sleep_tools';
import { registerAdapterTools } from './adapter_tools';
import { registerSelfExtensionTools } from './self_extension_tools';
import { registerUsageTools } from './usage_tools';
import { registerWorkProductTools } from './work_product_tools';
import { registerAuthorityResearchTools } from './authority_research_tools';
import { registerWorkTakeoverTools } from './work_takeover_tools';
import { registerDesktopAiTools } from './desktop_ai_tools';
import { registerExternalAiCollaborationTools } from './external_ai_collaboration_tools';
import { registerExternalAiHistoryTools } from './external_ai_history_tools';
import { registerMessagingTools } from './messaging_tools';
import { registerModelConfigurationTools } from './model_configuration_tools';
import { registerDesktopWechatWatchTools } from './desktop_wechat_watch_tools';
import { registerNetworkDiagnosticTools } from './network_diagnostic_tools';
import { registerRuntimeWorkTools } from './runtime_work_tools';
import { registerCadWorkflowTools } from './cad_workflow_tools';
import { registerExtensionRegistryTools } from './extension_registry_tools';
import { registerIndustryWorkflowTools } from './industry_workflow_tools';
import { PRODUCT_VARIANT } from '../../../shared/product_variant';

export function registerAllTools(
  registry: ToolRegistry,
  llmGetters?: {
    getDeepSeek: () => any;
    getGemini: () => any;
    getOpenAI?: () => any;
    getAnthropic?: () => any;
    getQwen?: () => any;
  },
): void {
  registerFileOpsTools(registry);
  registerSystemOpsTools(registry);
  registerWebOpsTools(registry);
  registerWebLoginTools(registry);
  registerCodeOpsTools(registry);
  registerDataOpsTools(registry);
  registerDesktopTools(registry);
  registerGitTools(registry);
  registerVerifyTools(registry);
  registerSkillTools(registry);
  registerOfficeTools(registry);
  registerCalendarTools(registry);
  registerAgentTools(registry);
  registerScreenMonitorTools(registry);
  registerClipboardTools(registry);
  registerOCRTools(registry);
  registerPdfTools(registry);
  registerDocumentTools(registry);
  registerKnowledgeTools(registry);
  registerWorkflowTools(registry);
  registerImageTools(registry);
  registerVideoTools(registry);
  registerInputTools(registry);
  registerComputerUseTool(registry);
  registerPythonTools(registry);
  registerBiometricTools(registry);
  registerLegalTools(registry);
  registerClientSelfTools(registry);
  registerModelConfigurationTools(registry);
  registerExternalAppTools(registry);
  registerCadWorkflowTools(registry);
  registerExternalControlTools(registry);
  registerAutonomyTools(registry);
  registerCapabilityResearchTools(registry);
  registerSleepTools(registry);
  registerAdapterTools(registry);
  registerSelfExtensionTools(registry);
  registerUsageTools(registry);
  registerWorkProductTools(registry);
  registerAuthorityResearchTools(registry);
  registerWorkTakeoverTools(registry);
  registerIndustryWorkflowTools(registry);
  registerDesktopAiTools(registry);
  registerExternalAiCollaborationTools(registry);
  registerExternalAiHistoryTools(registry);
  registerMessagingTools(registry);
  registerDesktopWechatWatchTools(registry);
  registerNetworkDiagnosticTools(registry);
  registerRuntimeWorkTools(registry);
  registerExtensionRegistryTools(registry);
  if (llmGetters) {
    setSkillLLMGetters(llmGetters);
  }
}


/**
 * Industry editions keep Lumi's cross-cutting core while registering only the
 * domain-heavy tool families needed by the active product line. Optional
 * extensions remain installable from Skill Hall, but do not silently expand
 * the default runtime.
 */
export function registerProductVariantTools(
  registry: ToolRegistry,
  llmGetters?: {
    getDeepSeek: () => any;
    getGemini: () => any;
    getOpenAI?: () => any;
    getAnthropic?: () => any;
    getQwen?: () => any;
  },
): void {
  const productLine = PRODUCT_VARIANT.productLine;
  if (!['design', 'legal', 'finance'].includes(productLine)) {
    throw new Error(`Unsupported industry tool profile: ${productLine}`);
  }

  // Lumi core: conversation execution, memory/knowledge access, models,
  // desktop/file work, messaging, external-agent coordination and receipts.
  registerFileOpsTools(registry);
  registerSystemOpsTools(registry);
  registerWebOpsTools(registry);
  registerWebLoginTools(registry);
  registerDataOpsTools(registry);
  registerDesktopTools(registry);
  registerVerifyTools(registry);
  registerSkillTools(registry);
  registerOfficeTools(registry);
  registerAgentTools(registry);
  registerScreenMonitorTools(registry);
  registerClipboardTools(registry);
  registerOCRTools(registry);
  registerPdfTools(registry);
  registerDocumentTools(registry);
  registerKnowledgeTools(registry);
  registerWorkflowTools(registry);
  registerInputTools(registry);
  registerComputerUseTool(registry);
  registerBiometricTools(registry);
  registerClientSelfTools(registry);
  registerModelConfigurationTools(registry);
  registerExternalAppTools(registry);
  registerExternalControlTools(registry);
  registerAutonomyTools(registry);
  registerCapabilityResearchTools(registry);
  registerSleepTools(registry);
  registerAdapterTools(registry);
  registerSelfExtensionTools(registry);
  registerUsageTools(registry);
  registerWorkProductTools(registry);
  registerWorkTakeoverTools(registry);
  registerIndustryWorkflowTools(registry);
  registerDesktopAiTools(registry);
  registerExternalAiCollaborationTools(registry);
  registerExternalAiHistoryTools(registry);
  registerMessagingTools(registry);
  registerDesktopWechatWatchTools(registry);
  registerNetworkDiagnosticTools(registry);
  registerRuntimeWorkTools(registry);
  registerExtensionRegistryTools(registry);

  if (productLine === 'design') {
    registerImageTools(registry);
    registerVideoTools(registry);
    registerPythonTools(registry);
    registerCadWorkflowTools(registry);
    registerAuthorityResearchTools(registry);
  } else if (productLine === 'legal') {
    registerCalendarTools(registry);
    registerLegalTools(registry);
    registerAuthorityResearchTools(registry);
  } else if (productLine === 'finance') {
    registerCalendarTools(registry);
    registerPythonTools(registry);
    registerAuthorityResearchTools(registry);
  }

  if (llmGetters) setSkillLLMGetters(llmGetters);
}
