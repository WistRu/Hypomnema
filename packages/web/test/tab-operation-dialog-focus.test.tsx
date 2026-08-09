import { afterEach, describe, expect, it, vi } from "vitest";

const modalMocks = vi.hoisted(() => ({
  activate: vi.fn(),
  cleanup: vi.fn(),
  dialog: {} as HTMLElement,
  effect: undefined as (() => void | (() => void)) | undefined,
  effectCleanup: undefined as (() => void) | undefined,
}));

vi.mock("react", async (importOriginal) => {
  const original = await importOriginal<typeof import("react")>();
  return {
    ...original,
    useEffect: (effect: () => void | (() => void)) => {
      modalMocks.effect = effect;
    },
    useRef: () => ({ current: modalMocks.dialog }),
  };
});

vi.mock("../src/modal-dialog", () => ({
  activateModalDialog: modalMocks.activate,
}));

import { TabOperationDialog } from "../src/TabOperationDialog";

describe("TabOperationDialog focus", () => {
  afterEach(() => {
    modalMocks.activate.mockReset();
    modalMocks.cleanup.mockReset();
    modalMocks.effect = undefined;
    modalMocks.effectCleanup = undefined;
    vi.unstubAllGlobals();
  });

  it("restores focus to the element that triggered the dialog", () => {
    class TestHTMLElement {
      getAttributeNames() {
        return [];
      }
    }
    const trigger = new TestHTMLElement();
    const onDismiss = vi.fn();
    modalMocks.activate.mockReturnValue(modalMocks.cleanup);

    TabOperationDialog({
      busy: false,
      candidateCount: 3,
      kind: "close",
      protectedCount: 0,
      onConfirm: vi.fn(),
      onDismiss,
    });
    vi.stubGlobal("HTMLElement", TestHTMLElement);
    vi.stubGlobal("document", { activeElement: trigger });
    modalMocks.effectCleanup = modalMocks.effect?.() ?? undefined;

    const activation = modalMocks.activate.mock.calls[0];
    expect(activation?.[0]).toBe(modalMocks.dialog);
    expect(activation?.[1] === trigger).toBe(true);
    expect(activation?.[2]).toBe(onDismiss);
    modalMocks.effectCleanup?.();
    expect(modalMocks.cleanup).toHaveBeenCalledOnce();
  });
});
