import { CreditCard } from 'lucide-react';

/** SVG card-type icons keyed by card brand identifier. */
const CardIcons: Record<string, React.ReactNode> = {
  visa: (
    <svg viewBox="0 0 24 24" className="w-8 h-8" fill="none">
      <rect width="24" height="24" rx="4" fill="#1A1F71" />
      <path d="M9.5 15.5L10.5 8.5H12.5L11.5 15.5H9.5Z" fill="white" />
      <path
        d="M16.5 8.7C16 8.5 15.2 8.3 14.2 8.3C12.2 8.3 10.8 9.3 10.8 10.8C10.8 11.9 11.8 12.5 12.6 12.9C13.4 13.3 13.7 13.5 13.7 13.9C13.7 14.4 13.1 14.7 12.5 14.7C11.7 14.7 11.2 14.5 10.5 14.2L10.2 14.1L9.9 16C10.5 16.3 11.5 16.5 12.5 16.5C14.6 16.5 16 15.5 16 13.9C16 13 15.5 12.3 14.4 11.8C13.7 11.4 13.2 11.2 13.2 10.7C13.2 10.3 13.6 9.9 14.5 9.9C15.2 9.9 15.8 10 16.2 10.2L16.4 10.3L16.5 8.7Z"
        fill="white"
      />
      <path
        d="M19.5 8.5H18C17.5 8.5 17.1 8.7 16.9 9.2L14 15.5H16.1L16.5 14.3H19.1L19.3 15.5H21.2L19.5 8.5ZM17.1 12.7L18.1 10.1L18.7 12.7H17.1Z"
        fill="white"
      />
      <path
        d="M8 8.5L6 13.5L5.8 12.5C5.4 11.2 4.2 9.8 2.8 9L4.6 15.5H6.8L10.2 8.5H8Z"
        fill="white"
      />
    </svg>
  ),
  mastercard: (
    <svg viewBox="0 0 24 24" className="w-8 h-8" fill="none">
      <rect width="24" height="24" rx="4" fill="#000" />
      <circle cx="9" cy="12" r="5" fill="#EB001B" />
      <circle cx="15" cy="12" r="5" fill="#F79E1B" />
      <path
        d="M12 8.5C13.1 9.4 13.8 10.6 13.8 12C13.8 13.4 13.1 14.6 12 15.5C10.9 14.6 10.2 13.4 10.2 12C10.2 10.6 10.9 9.4 12 8.5Z"
        fill="#FF5F00"
      />
    </svg>
  ),
  amex: (
    <svg viewBox="0 0 24 24" className="w-8 h-8" fill="none">
      <rect width="24" height="24" rx="4" fill="#006FCF" />
      <path d="M3 12L5 8H7L9 12L7 16H5L3 12Z" fill="white" />
      <path d="M9 8H13V10H11V11H13V13H11V14H13V16H9V8Z" fill="white" />
      <path
        d="M14 8H16L17.5 11L19 8H21L18.5 12L21 16H19L17.5 13L16 16H14L16.5 12L14 8Z"
        fill="white"
      />
    </svg>
  ),
  discover: (
    <svg viewBox="0 0 24 24" className="w-8 h-8" fill="none">
      <rect width="24" height="24" rx="4" fill="#FF6000" />
      <circle cx="12" cy="12" r="4" fill="white" />
      <path d="M4 10H6V14H4V10Z" fill="white" />
      <path d="M18 10H20V14H18V10Z" fill="white" />
    </svg>
  ),
  unknown: <CreditCard className="w-8 h-8 text-muted-foreground" />,
};

export default CardIcons;
