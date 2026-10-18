/** Pure check of private decrypted DB records; only minimal proof is returned. */
export function checkReceipts(
  rows: any[],
  scope: any,
  reportedHeading: string,
) {
  const reads = new Set([
    "screen.text",
    "screen.text_pixels",
    "screen.bounds",
    "session.state",
    "apps.current",
    "apps.list",
    "tree",
  ]);
  let launch: any = null;
  let read: any = null;
  let allCommandsAllowed = true;
  const heading =
    typeof reportedHeading === "string" ? reportedHeading.trim() : "";
  for (const row of rows) {
    if (
      row.userId !== scope.userId ||
      !scope.agentIds.includes(row.agentId) ||
      row.deviceId !== scope.deviceId ||
      row.actor !== "agent" ||
      row.state !== "SUCCEEDED" ||
      !row.completedAt
    ) {
      allCommandsAllowed = false;
      continue;
    }
    if (row.operation === "nav.home") {
      if (launch) allCommandsAllowed = false; // only initial lock-screen dismissal
      continue;
    }
    if (row.operation === "apps.launch") {
      const settings =
        row.request?.operation === "apps.launch" &&
        row.request?.actor === "agent" &&
        ["Settings", "com.apple.Preferences"].includes(
          row.request?.args?.name,
        ) &&
        row.result === "com.apple.Preferences";
      if (!settings) allCommandsAllowed = false;
      else {
        launch = row;
        read = null;
      }
    } else if (!reads.has(row.operation)) allCommandsAllowed = false;
    if (
      launch &&
      row.operation === "screen.text" &&
      row.leaseId === launch.leaseId &&
      row.cursor > launch.cursor &&
      row.createdAt >= launch.completedAt &&
      Array.isArray(row.result)
    ) {
      // 0.3.2 screen.text is a flat [{text,confidence,source,x,y,w,h}] OCR array.
      // Never recursively collect strings from envelopes, errors, or metadata.
      const valid =
        row.result.length > 0 &&
        row.result.every(
          (box: any) =>
            box &&
            typeof box.text === "string" &&
            box.text.trim() &&
            box.source === "pixels" &&
            ["confidence", "x", "y", "w", "h"].every(
              (key) =>
                typeof box[key] === "number" && Number.isFinite(box[key]),
            ) &&
            box.confidence >= 0.3 &&
            box.confidence <= 1 &&
            box.w > 0 &&
            box.h > 0,
        );
      if (
        valid &&
        heading &&
        row.result.some((box: any) => box.text.trim() === heading)
      )
        read = row;
    }
  }
  return {
    source: "persisted-iphone-commands-v1",
    userId: scope.userId,
    rootAgentId: scope.rootAgentId,
    launchId: launch?.id ?? null,
    readId: allCommandsAllowed ? (read?.id ?? null) : null,
    heading: allCommandsAllowed && read ? heading : null,
    ordered: allCommandsAllowed && !!read,
    allCommandsAllowed,
  };
}
