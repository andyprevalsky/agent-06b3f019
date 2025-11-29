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
];

const stateCopy: Record<
  UpdateStatusPayload["state"],
  { title: string; description: string }
> = {
  idle: {
    title: "",
    description: "",
  },
  none: {
    title: "You're up to date",
    description: "",
  },
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
  const [visible, setVisible] = useState(false);
  const [progress, setProgress] = useState(0);
  const dismissedVersionRef = useRef<string | null>(null);

  const container = useMemo(() => {
    const node =
      document.getElementById(portalId) ?? Object.assign(document.createElement("div"), { id: portalId });
    if (!node.isConnected) {
      document.body.appendChild(node);
    }
    return node;
  }, []);

  useEffect(() => {
    return () => {
      if (container.isConnected) {
        container.remove();
      }
    };
  }, [container]);

  useEffect(() => {
    window.api.onUpdateStatus((payload) => {
      setStatus(payload);
      const shouldDisplay =
        ACTIVE_STATES.includes(payload.state) &&
        !(payload.state === "available" && dismissedVersionRef.current === payload.version);

      if (payload.state === "available") {
        dismissedVersionRef.current = null;
      }

      if (payload.state === "none") {
        setVisible(false);
        return;
      }

      setVisible(shouldDisplay);
    });

    window.api.onUpdateProgress((percent) => {
      setProgress(percent);
    });
  }, []);

  if (!visible || !container) {
    return null;
  }

  const { title, description } = stateCopy[status.state] ?? stateCopy.idle;
  const percent = Math.round(status.percent ?? progress ?? 0);
  const versionLabel = status.version ? `v${status.version}` : null;

  const dismiss = () => {
    if (status.state === "available" && status.version) {
      dismissedVersionRef.current = status.version;
    }
    setVisible(false);
  };

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
          <Button size="sm" variant="ghost" onClick={() => window.api.checkForUpdates()}>
            Refresh
          </Button>
        );
      case "checking":
        return (
          <div className="flex items-center gap-2 text-xs text-neutral-300">
            <span className="h-3 w-3 animate-spin rounded-full border-[1.5px] border-white/30 border-t-transparent" />
            Checking…
          </div>
        );
      default:
        return null;
    }
  };

  const showProgressBar = status.state === "downloading";

  return createPortal(
    <div className="pointer-events-auto fixed bottom-6 left-6 z-[9999] w-full max-w-xs animate-in fade-in slide-in-from-bottom-2">
      <div className="rounded-2xl border border-white/10 bg-[#050505]/90 p-4 shadow-2xl backdrop-blur">
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold text-white">{title}</p>
          {versionLabel ? (
            <span className="rounded-full bg-white/10 px-2 py-0.5 text-[11px] font-medium text-neutral-300">
              {versionLabel}
            </span>
          ) : null}
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

