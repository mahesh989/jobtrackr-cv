/**
 * Provider/model metadata shared between the admin AI-settings UI
 * (components/admin/PlatformAiSettings.tsx) and the server-side default
 * resolution (lib/ai/activeProvider.ts). Single source of truth so the
 * "recommended" model shown to the admin always matches the fallback used
 * when platform_ai_settings.model is empty.
 */

export type AiProvider = "anthropic" | "openai" | "deepseek";

export const PROVIDER_ORDER: AiProvider[] = ["anthropic", "openai", "deepseek"];

export interface ProviderModelMeta {
  label:        string;
  tagline:      string;
  color:        string;
  placeholder:  string;
  helpUrl:      string;
  defaultModel: string;
  models: { value: string; label: string; tag: string }[];
}

export const PROVIDER_META: Record<AiProvider, ProviderModelMeta> = {
  anthropic: {
    label:        "Anthropic",
    tagline:      "Claude Opus & Sonnet families",
    color:        "#b86a00",
    placeholder:  "sk-ant-...",
    helpUrl:      "https://console.anthropic.com/account/keys",
    defaultModel: "claude-sonnet-4-6",
    models: [
      { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", tag: "recommended"  },
      { value: "claude-opus-4-8",   label: "Claude Opus 4.8",   tag: "latest"       },
      { value: "claude-opus-4-7",   label: "Claude Opus 4.7",   tag: "most capable" },
      { value: "claude-opus-4-6",   label: "Claude Opus 4.6",   tag: "stable"       },
    ],
  },
  openai: {
    label:        "OpenAI",
    tagline:      "GPT-5 family",
    color:        "#10a37f",
    placeholder:  "sk-...",
    helpUrl:      "https://platform.openai.com/api-keys",
    defaultModel: "gpt-5.1",
    models: [
      { value: "gpt-5.1", label: "GPT-5.1", tag: "recommended" },
      { value: "gpt-5",   label: "GPT-5",   tag: "base"        },
      { value: "gpt-5.2", label: "GPT-5.2", tag: "newer"       },
      { value: "gpt-5.5", label: "GPT-5.5", tag: "latest"      },
    ],
  },
  deepseek: {
    label:        "DeepSeek",
    tagline:      "deepseek-chat & deepseek-reasoner",
    color:        "#4d6ef5",
    placeholder:  "sk-...",
    helpUrl:      "https://platform.deepseek.com/api_keys",
    defaultModel: "deepseek-chat",
    models: [
      { value: "deepseek-chat",     label: "deepseek-chat",     tag: "default"   },
      { value: "deepseek-reasoner", label: "deepseek-reasoner", tag: "reasoning" },
    ],
  },
};

export const DEFAULT_MODELS: Record<AiProvider, string> = {
  anthropic: PROVIDER_META.anthropic.defaultModel,
  openai:    PROVIDER_META.openai.defaultModel,
  deepseek:  PROVIDER_META.deepseek.defaultModel,
};
