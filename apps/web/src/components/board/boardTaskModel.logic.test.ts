import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ServerProvider,
} from "@t3tools/contracts";
import { DEFAULT_UNIFIED_SETTINGS } from "@t3tools/contracts/settings";
import { describe, expect, it } from "vite-plus/test";

import { resolveBoardTaskModelSelection } from "./boardTaskModel.logic";

function provider(input: {
  instanceId: string;
  driver: string;
  models: ReadonlyArray<string>;
  enabled?: boolean;
}): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(input.instanceId),
    driver: ProviderDriverKind.make(input.driver),
    enabled: input.enabled ?? true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-01-01T00:00:00.000Z",
    models: input.models.map((slug) => ({ slug, name: slug, isCustom: false, capabilities: {} })),
    slashCommands: [],
    skills: [],
  };
}

const codex = provider({ instanceId: "codex", driver: "codex", models: ["gpt-5.4"] });
const claude = provider({
  instanceId: "claudeAgent",
  driver: "claudeAgent",
  models: ["claude-opus-4-8"],
});
const selection = (instanceId: string, model: string): ModelSelection => ({
  instanceId: ProviderInstanceId.make(instanceId),
  model,
});
const noSticky = { activeProvider: null, byProvider: {} };
const resolve = (input: Partial<Parameters<typeof resolveBoardTaskModelSelection>[0]>) =>
  resolveBoardTaskModelSelection({
    projectDefault: null,
    sticky: noSticky,
    providers: [codex, claude],
    settings: DEFAULT_UNIFIED_SETTINGS,
    ...input,
  });

describe("resolveBoardTaskModelSelection", () => {
  it("prefers the project's default model", () => {
    expect(
      resolve({
        projectDefault: selection("claudeAgent", "claude-opus-4-8"),
        sticky: {
          activeProvider: ProviderInstanceId.make("codex"),
          byProvider: { [ProviderInstanceId.make("codex")]: selection("codex", "gpt-5.4") },
        },
      }),
    ).toEqual(selection("claudeAgent", "claude-opus-4-8"));
  });

  it("falls back to the sticky composer pick, like a new thread", () => {
    expect(
      resolve({
        sticky: {
          activeProvider: ProviderInstanceId.make("claudeAgent"),
          byProvider: {
            [ProviderInstanceId.make("claudeAgent")]: selection("claudeAgent", "claude-opus-4-8"),
          },
        },
      }),
    ).toEqual(selection("claudeAgent", "claude-opus-4-8"));
  });

  it("never picks an instance that has no provider here, such as a mirrored terminal's", () => {
    const placeholder = selection("claudeAttached", "claude-opus-4-8");
    const result = resolve({
      projectDefault: placeholder,
      sticky: {
        activeProvider: ProviderInstanceId.make("claudeAttached"),
        byProvider: { [ProviderInstanceId.make("claudeAttached")]: placeholder },
      },
    });
    expect(result?.instanceId).toBe(ProviderInstanceId.make("codex"));
    expect(result?.model).toBe("gpt-5.4");
  });

  it("skips disabled providers and returns null when nothing can run the task", () => {
    expect(
      resolve({
        projectDefault: selection("codex", "gpt-5.4"),
        providers: [{ ...codex, enabled: false }, claude],
      })?.instanceId,
    ).toBe(ProviderInstanceId.make("claudeAgent"));
    expect(resolve({ providers: [] })).toBeNull();
  });
});
