import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { useComposerDraftStore } from "../../composerDraftStore";
import { snapshotComposerSend } from "../ChatView.logic";
import { recoverComposerSend, startThreadSubmission } from "./chatViewSend";

vi.mock("../ui/toast", () => ({
  toastManager: { add: vi.fn(), close: vi.fn() },
  stackedThreadToast: (input: unknown) => input,
}));

it("removes a failed optimistic message without overwriting a newer draft", () => {
  const draftTarget = scopeThreadRef(EnvironmentId.make("test"), ThreadId.make("failure"));
  const snapshot = snapshotComposerSend({
    prompt: "Failed prompt",
    images: [],
    files: [],
    terminalContexts: [],
    sendableTerminalContexts: [],
    previewAnnotations: [],
    reviewComments: [],
    threadContexts: [],
    environmentContexts: [],
  });
  useComposerDraftStore.getState().setPrompt(draftTarget, "My next prompt");
  const discardOptimisticMessage = vi.fn();
  expect(recoverComposerSend({ draftTarget, snapshot, discardOptimisticMessage })).toBeNull();
  expect(discardOptimisticMessage).toHaveBeenCalledOnce();
  expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt).toBe(
    "My next prompt",
  );
  useComposerDraftStore.getState().setPrompt(draftTarget, "");
  expect(recoverComposerSend({ draftTarget, snapshot, discardOptimisticMessage })).toEqual([]);
  expect(useComposerDraftStore.getState().getComposerDraft(draftTarget)?.prompt).toBe(
    "Failed prompt",
  );
});

it("does not resubmit an existing thread after a lost acknowledgement until retry is allowed", async () => {
  const threadId = ThreadId.make("uncertain-existing-thread");
  const uncertainSubmissions = new Map<string, ThreadId>();
  const failure = AsyncResult.failure(Cause.fail(new Error("Lost acknowledgement")));
  const start = vi.fn(async () => failure);
  const input = {
    retryKey: "existing",
    model: "model",
    threadId,
    uncertainSubmissions,
    start,
    openThread: vi.fn(),
  };
  expect(await startThreadSubmission(input)).toBe(failure);
  expect(uncertainSubmissions.get(input.retryKey)).toBe(threadId);
  expect((await startThreadSubmission(input))._tag).toBe("Failure");
  expect(start).toHaveBeenCalledTimes(1);
  uncertainSubmissions.delete(input.retryKey);
  expect((await startThreadSubmission(input))._tag).toBe("Failure");
  expect(start).toHaveBeenCalledTimes(2);
});
