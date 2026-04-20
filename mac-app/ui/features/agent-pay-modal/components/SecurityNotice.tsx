import { ExternalLink, ShieldAlert } from 'lucide-react';

/**
 * Yellow notice with the e2e-encryption disclosure and the Privacy.com
 * link. Pure presentational.
 */
export const SecurityNotice = () => (
  <div className="flex items-start gap-2 p-3 bg-amber-500/10 border border-amber-500/30 rounded-lg">
    <ShieldAlert className="w-4 h-4 text-amber-600 dark:text-amber-400 mt-0.5 flex-shrink-0" />
    <div className="flex-1 space-y-1.5">
      <p className="text-xs text-amber-800 dark:text-amber-200">
        <span className="font-medium">All card credentials are end-to-end encrypted.</span> We
        recommend creating a separate card for your agent.
      </p>
      <a
        href="https://privacy.com"
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium bg-black text-white rounded hover:bg-black/80 transition-colors"
      >
        <ExternalLink className="w-3 h-3" />
        Create Card via Privacy.com
      </a>
    </div>
  </div>
);
