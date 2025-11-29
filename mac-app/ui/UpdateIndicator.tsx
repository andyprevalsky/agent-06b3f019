import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Button } from "@/components/ui/button";
import type { UpdateStatusPayload } from "../shared/types/ipc";

const ACTIVE_STATES: Array<UpdateStatusPayload["state"]> = [
  "checking",
  "available",
  "downloading",
  "downloaded",
  "building",
  "error",
  "none",
];

const NONE_DISMISS_DELAY = 3000;

const stateCopy: Record<
  UpdateStatusPayload["state"],
  { title: string; description: string }
> = {
  idle: { title: "", description: "" },
  none: { title: "You're up to date", description: "" },
  checking: {
    title: "Checking for updates…",
    description: "Hang tight while we look for the latest build.",
  },
  available: {
    title: "New version available",
    description: "Download to get the latest improvements.",
  },
  downloading: {
    title: "Downloading update…",
    description: "We'll restart once the download finishes.",
  },
  downloaded: {
    title: "Update ready to install",
    description: "Restart Rose to finish updating.",
  },
  building: {
    title: "Publishing build…",
    description: "GitHub is still preparing the latest release.",
  },
  error: {
    title: "Update check failed",
    description: "We couldn't reach GitHub. Please try again.",
  },
};

const portalId = "rose-update-indicator";

export default function UpdateIndicator() {
  const [status, setStatus] = useState<UpdateStatusPayload>({ state: "idle" });
  const [progress, setProgress] = useState(0);
  const [showNoneChip, setShowNoneChip] = useState(false);
  const dismissedVersionRef = useRef<string | null>(null);
  const noneTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const listenerAttachedRef = useRef(false);

  const container = useMemo(() => {
    const existing = document.getElementById(portalId);
    if (existing) return existing;
    const node = document.createElement("div");
    node.id = portalId;
    document.body.appendChild(node);
    return node;
  }, []);

  useEffect(() => {
    return () => {
      const node = document.getElementById(portalId);
      if (node) node.remove();
    };
  }, []);

  useEffect(() => {
    // Prevent duplicate listeners
    if (listenerAttachedRef.current) return;
    listenerAttachedRef.current = true;

    window.api.onUpdateStatus((payload) => {
      // Clear any pending "none" timer when new status arrives
      if (noneTimerRef.current) {
        clearTimeout(noneTimerRef.current);
        noneTimerRef.current = null;
      }

      setStatus(payload);

      // Handle "none" state specially - show chip then auto-dismiss
      if (payload.state === "none") {
        setShowNoneChip(true);
        noneTimerRef.current = setTimeout(() => {
          setShowNoneChip(false);
          noneTimerRef.current = null;
        }, NONE_DISMISS_DELAY);
      } else {
        setShowNoneChip(false);
      }
    });

    window.api.onUpdateProgress((percent) => {
      setProgress(percent);
    });

    return () => {
      if (noneTimerRef.current) {
        clearTimeout(noneTimerRef.current);
      }
    };
  }, []);

  const dismiss = () => {
    if (status.state === "available" && status.version) {
      dismissedVersionRef.current = status.version;
    }
    setStatus({ state: "idle" });
    setShowNoneChip(false);
    if (noneTimerRef.current) {
      clearTimeout(noneTimerRef.current);
      noneTimerRef.current = null;
    }
  };

  // Determine what to show
  const isActive = ACTIVE_STATES.includes(status.state);
  const isDismissedVersion =
    status.state === "available" &&
    dismissedVersionRef.current === status.version;

  // Don't show anything for idle or dismissed versions
  if (status.state === "idle" || isDismissedVersion) {
    return null;
  }

  // Show spinner only for checking
  if (status.state === "checking") {
    return createPortal(
      <div className="pointer-events-none fixed bottom-6 left-6 z-[9999]">
        <div className="h-5 w-5 animate-spin rounded-full border-2 border-neutral-400 border-t-transparent" />
      </div>,
      container
    );
  }

  // Show chip for "none" state (up to date) - controlled by showNoneChip flag
  if (status.state === "none") {
    if (!showNoneChip) return null;
    return createPortal(
      <div className="pointer-events-auto fixed bottom-6 left-6 z-[9999]">
        <div
          className="flex items-center gap-2 rounded-full bg-neutral-100 border border-neutral-200 px-3 py-1.5 shadow-sm cursor-pointer hover:bg-neutral-200 transition-colors"
          onClick={dismiss}
        >
          <svg
            className="h-3.5 w-3.5 text-neutral-600"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2.5}
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M5 13l4 4L19 7"
            />
          </svg>
          <span className="text-xs font-medium text-neutral-600">Up to date</span>
        </div>
      </div>,
      container
    );
  }

  // Show chip for "available" state - new update available
  if (status.state === "available") {
    return createPortal(
      <div className="pointer-events-auto fixed bottom-6 left-6 z-[9999]">
        <div className="flex items-center justify-between gap-4 rounded-full bg-neutral-100 border border-neutral-200 px-3 py-1.5 shadow-sm">
          <div className="flex items-center gap-2">
            <svg
              className="h-3.5 w-3.5 text-neutral-600"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M12 3.5c1.5-1.5 4-1.5 5 0s1 3.5-1 5h4v3H4v-3h4c-2-1.5-2-4-1-5s3.5-1.5 5 0zM5 11.5v9h14v-9M12 8.5v12"
              />
            </svg>
            <span className="text-xs font-medium text-neutral-600">New update available</span>
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={dismiss}
              className="text-xs font-medium text-neutral-500 hover:text-neutral-700 transition-colors"
            >
              Later
            </button>
            <button
              onClick={() => window.api.downloadUpdate()}
              className="text-xs font-medium text-neutral-700 bg-neutral-200 hover:bg-neutral-300 px-2.5 py-1 rounded-full transition-colors"
            >
              Install Now
            </button>
          </div>
        </div>
      </div>,
      container
    );
  }

  // Don't show for non-active states
  if (!isActive) return null;

  const { title, description } = stateCopy[status.state] ?? stateCopy.idle;
  const percent = Math.round(status.percent ?? progress ?? 0);
  const versionLabel = status.version ? `v${status.version}` : null;
  const showProgressBar = status.state === "downloading";

  const actions = () => {
    switch (status.state) {
      case "available":
        return (
          <>
            <Button size="sm" onClick={() => window.api.downloadUpdate()}>
              Download
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Later
            </Button>
          </>
        );
      case "downloading":
        return (
          <span className="text-xs text-neutral-400">{percent}% complete</span>
        );
      case "downloaded":
        return (
          <>
            <Button size="sm" onClick={() => window.api.restartToUpdate()}>
              Restart to Update
            </Button>
            <Button size="sm" variant="ghost" onClick={dismiss}>
              Later
            </Button>
          </>
        );
      case "error":
        return (
          <Button size="sm" onClick={() => window.api.checkForUpdates()}>
            Retry
          </Button>
        );
      case "building":
        return (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => window.api.checkForUpdates()}
          >
            Refresh
          </Button>
        );
      default:
        return null;
    }
  };

  return createPortal(
    <div className="pointer-events-auto fixed bottom-6 left-6 z-[9999] w-full max-w-xs">
      <div className="rounded-2xl border border-white/10 bg-[#050505]/90 p-4 shadow-2xl backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-white">{title}</p>
          {versionLabel && (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-neutral-300">
              {versionLabel}
            </span>
          )}
        </div>
        {description && (
          <p className="mt-1 text-xs text-neutral-400">{description}</p>
        )}
        {showProgressBar && (
          <div className="mt-4 h-2 rounded-full bg-white/10">
            <div
              className="h-full rounded-full bg-white transition-all duration-200"
              style={{ width: `${Math.min(percent, 100)}%` }}
            />
          </div>
        )}
        <div className="mt-4 flex flex-wrap items-center gap-2">{actions()}</div>
      </div>
    </div>,
    container
  );
}
