/**
 * STATE MACHINE: ConnectedStatusText
 *
 * [DISCONNECTED] -> renders nothing
 * [CONNECTED] -> renders subtle status text below the row title
 *
 * System context:
 *   Integration row label stack -> small status text, paired with the synced icon glow.
 */

interface ConnectedStatusTextProps {
  isConnected: boolean;
}

export default function ConnectedStatusText({
  isConnected,
}: ConnectedStatusTextProps): JSX.Element | null {
  if (!isConnected) return null;

  return (
    <span className="mt-0.5 block text-[10px] font-medium leading-3 text-blue-600/70 dark:text-blue-300/75">
      Connected
    </span>
  );
}
