/**
 * STATE MACHINE: BrowserIcon
 *
 * [MOUNTED] --> renders browser-type icon (pure, stateless).
 */

import type { BrowserType } from '@/features/integration-handlers-context';

import chromeIcon from '@/assets/chrome-icon.png';
import chatgptIcon from '@/assets/chatgpt-icon.webp';
import braveIcon from '@/assets/brave-icon.webp';
import safariIcon from '@/assets/safari-icon.png';

interface BrowserIconProps {
  type: BrowserType;
  className?: string;
}

function EdgeIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48">
      <defs>
        <linearGradient id="edge1" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#0078D4" />
          <stop offset="100%" stopColor="#1AEBFF" />
        </linearGradient>
        <linearGradient id="edge2" x1="0%" y1="100%" x2="100%" y2="0%">
          <stop offset="0%" stopColor="#50E6FF" />
          <stop offset="100%" stopColor="#32BEDD" />
        </linearGradient>
      </defs>
      <path
        fill="url(#edge1)"
        d="M24 4C12.95 4 4 12.95 4 24c0 6.63 3.23 12.5 8.2 16.15 1.15-5.35 5.8-9.35 11.35-9.35 3.05 0 5.85 1.2 7.95 3.15C37.5 31.5 42 28.1 42 24c0-11.05-8.05-20-18-20z"
      />
      <path
        fill="url(#edge2)"
        d="M23.55 30.8c-5.55 0-10.2 4-11.35 9.35C16.35 43.1 20 44 24 44c11.05 0 20-8.95 20-20 0 4.1-4.5 7.5-10.5 9.95-2.1-1.95-4.9-3.15-7.95-3.15z"
      />
    </svg>
  );
}

function ArcIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48">
      <defs>
        <linearGradient id="arcGrad" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stopColor="#FF6B6B" />
          <stop offset="25%" stopColor="#FF8E53" />
          <stop offset="50%" stopColor="#FFCD56" />
          <stop offset="75%" stopColor="#6BCB77" />
          <stop offset="100%" stopColor="#4D96FF" />
        </linearGradient>
      </defs>
      <circle cx="24" cy="24" r="20" fill="url(#arcGrad)" />
      <circle cx="24" cy="24" r="12" fill="white" />
    </svg>
  );
}

function OperaIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48">
      <ellipse cx="24" cy="24" rx="20" ry="22" fill="#FF1B2D" />
      <ellipse cx="24" cy="24" rx="10" ry="16" fill="white" />
    </svg>
  );
}

function VivaldiIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="22" fill="#EF3939" />
      <path
        fill="white"
        d="M24 8c-8.8 0-16 7.2-16 16s7.2 16 16 16c4 0 7.6-1.5 10.4-3.9L24 24l10.4-12.1C31.6 9.5 28 8 24 8z"
      />
    </svg>
  );
}

function ChromiumIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="22" fill="#4587F3" />
      <path fill="#7BAAF7" d="M24 2C12.95 2 4 10.95 4 22h20l9.5-16.5A21.9 21.9 0 0024 2z" />
      <path fill="#A8C7FA" d="M4 22c0 11.05 8.95 20 20 20 4.57 0 8.78-1.53 12.17-4.1L26.5 22H4z" />
      <path fill="#669DF6" d="M24 42c8.28 0 15.35-5.03 18.37-12.2L33.5 16.5 24 22v20z" />
      <circle cx="24" cy="24" r="10" fill="white" />
      <circle cx="24" cy="24" r="8" fill="#4587F3" />
    </svg>
  );
}

function DefaultBrowserIcon({ className }: { className: string }) {
  return (
    <svg className={className} viewBox="0 0 48 48">
      <circle cx="24" cy="24" r="20" fill="#888" />
      <circle cx="24" cy="24" r="8" fill="white" />
    </svg>
  );
}

export default function BrowserIcon({ type, className = 'w-4 h-4' }: BrowserIconProps) {
  switch (type) {
    case 'chrome':
      return <img src={chromeIcon} alt="Chrome" className={className} />;
    case 'edge':
      return <EdgeIcon className={className} />;
    case 'brave':
      return <img src={braveIcon} alt="Brave" className={`${className} bg-white rounded`} />;
    case 'arc':
      return <ArcIcon className={className} />;
    case 'opera':
      return <OperaIcon className={className} />;
    case 'vivaldi':
      return <VivaldiIcon className={className} />;
    case 'chromium':
      return <ChromiumIcon className={className} />;
    case 'atlas':
      return <img src={chatgptIcon} alt="ChatGPT" className={`${className} rounded`} />;
    case 'safari':
      return <img src={safariIcon} alt="Safari" className={className} />;
    default:
      return <DefaultBrowserIcon className={className} />;
  }
}
