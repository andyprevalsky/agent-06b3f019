/** Private-process protocol validation; never returns identity, command text or OCR. */
export function checkCritical(s: any, rejected = false, custody?: any) {
  const a = s.attentions?.[0],
    l = s.lease,
    d = s.device,
    p = s.setup,
    t = p?.attempt;
  const target = {
    kind: "iphone",
    browserTaskId: l?.browserTaskId,
    leaseId: l?.id,
  };
  const same = (x: any) =>
    x?.kind === target.kind &&
    x?.browserTaskId === target.browserTaskId &&
    x?.leaseId === target.leaseId;
  const m = a?.metadata,
    auth = a?.authAssistance;
  const generation = s.agent?.temporalWorkflowId ?? s.agent?.id;
  const rows = s.operations ?? [];
  const bound =
    s.userId === "c49b4ce3-3489-499d-bfbd-846d04ba6275" &&
    s.agentIds?.includes(a?.agentId) &&
    a?.userId === s.userId &&
    l?.userId === s.userId &&
    l?.agentId === a?.agentId &&
    d?.userId === s.userId &&
    d?.providerDeviceId === s.deviceId &&
    l?.deviceId === d?.id &&
    t?.leaseId === l?.id &&
    t?.taskId === l?.browserTaskId &&
    t?.agentId === l?.agentId &&
    t?.workflowId === generation &&
    a?.workflowId === generation &&
    s.task?.id === l?.browserTaskId &&
    s.task?.context?.userId === s.userId &&
    s.task?.agentId === l?.agentId;
  const metadata =
    m?.attentionKind === "auth_assistance" &&
    same(m?.target) &&
    same(m?.authAssistance?.target) &&
    same(m?.requestUserAuthentication?.target) &&
    [
      "password",
      "verification_code",
      "device_passcode",
      "manual_verification",
    ].includes(m?.criticalReason) &&
    m.authAssistance.criticalReason === m.criticalReason &&
    m.requestUserAuthentication.criticalReason === m.criticalReason &&
    m.authAssistance.requestId === a?.id &&
    m.requestUserAuthentication.requestId === a?.id &&
    m.authAssistance.expectedCursor === l?.actionCursor;
  const message = s.messages?.some(
    (x: any) =>
      x.agentId === l?.agentId &&
      x.workflowGeneration === generation &&
      x.metadata?.authAssistance?.requestId === a?.id &&
      same(x.metadata.authAssistance.target) &&
      x.metadata?.requestUserAuthentication?.requestId === a?.id &&
      same(x.metadata.requestUserAuthentication.target),
  );
  const allowed = new Set([
    "screen.text",
    "screen.text_pixels",
    "screen.bounds",
    "session.state",
    "apps.current",
    "apps.list",
    "tree",
    "apps.launch",
    "input.tap",
    "input.press",
    "input.drag",
    "input.scroll",
    "input.text",
    "input.keys",
    "nav.home",
    "setup.defer",
    "setup.block",
  ]);
  const safe = rows.every(
    (r: any) =>
      r.actor === "agent" &&
      allowed.has(r.operation) &&
      (r.operation !== "apps.launch" ||
        ["Settings", "com.apple.Preferences"].includes(
          r.request?.args?.name,
        )) &&
      (r.operation !== "input.text" ||
        (typeof p?.expectedAppleIdentity === "string" &&
          r.request?.args?.s === p.expectedAppleIdentity &&
          r.request?.setupAttemptId === t?.id &&
          r.request?.setupRevision === t?.revision)) &&
      !["setup.verify"].includes(r.operation),
  );
  const read = rows.find(
    (r: any) =>
      r.operation === "screen.text" &&
      r.state === "SUCCEEDED" &&
      r.leaseId === l?.id &&
      r.providerEpoch ===
        (rejected && custody ? custody.epoch : d?.providerEpoch) &&
      r.completedAt &&
      r.completedAt <= a?.createdAt &&
      r.cursor <= m?.authAssistance?.expectedCursor &&
      r.request?.setupAttemptId === t?.id &&
      r.request?.setupRevision === t?.revision &&
      r.cursor > t?.floorCursor &&
      r.completedAt >= new Date(t?.floorAt).getTime() &&
      !rows.some(
        (later: any) =>
          later.cursor > r.cursor &&
          ![
            "screen.text",
            "screen.bounds",
            "screen.text_pixels",
            "apps.current",
            "apps.list",
            "session.state",
            "tree",
          ].includes(later.operation),
      ) &&
      Array.isArray(r.result) &&
      r.result.length > 0 &&
      r.result.every(
        (box: any) =>
          box &&
          typeof box.text === "string" &&
          box.text.trim() &&
          box.source === "pixels" &&
          ["confidence", "x", "y", "w", "h"].every(
            (k) => typeof box[k] === "number" && Number.isFinite(box[k]),
          ) &&
          box.confidence >= 0.3 &&
          box.confidence <= 1 &&
          box.w > 0 &&
          box.h > 0,
      ),
  );
  const valid = !!(
    bound &&
    metadata &&
    message &&
    safe &&
    read &&
    typeof p?.expectedAppleIdentity === "string" &&
    !!p.expectedAppleIdentity &&
    p.profileRevision > 0 &&
    s.attentions.length === 1 &&
    auth?.id === a.id &&
    auth?.userId === s.userId &&
    auth?.agentId === a.agentId &&
    auth.browserSessionId === null &&
    auth.steelSessionId === "" &&
    auth.authRealm === "iphone" &&
    auth.mode === "manual_step" &&
    auth.completedAt === null &&
    (rejected
      ? a.userResponse === "__REJECTED__"
      : a.userResponse === null &&
        l.status === "ACTIVE" &&
        l.activeDeviceId === d.id &&
        l.releaseRequestedAt === null &&
        d.providerState !== "CLOSING" &&
        l.controlOwner === "user" &&
        l.attentionRequestId === a.id &&
        s.privacy?.active === true) &&
    !p.verified &&
    d.setupState !== "ready" &&
    !rows.some((r: any) =>
      ["RUNNING", "CONNECTING", "UNKNOWN"].includes(r.state),
    )
  );
  return {
    source: "persisted-native-attention-v1",
    protocolOnly: true,
    valid,
    rejected: rejected && valid,
    requestId: valid ? a.id : null,
    leaseId: valid ? l.id : null,
    reason: valid ? m.criticalReason : null,
    custody: valid
      ? {
          epoch: d.providerEpoch,
          attemptId: t.id,
          revision: t.revision,
          profileRevision: p.profileRevision,
          generation,
          cursor: l.actionCursor,
          operationIds: rows.map((r: any) => r.id),
        }
      : null,
  };
}
