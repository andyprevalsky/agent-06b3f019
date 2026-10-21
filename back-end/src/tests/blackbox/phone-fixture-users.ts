/** Unique synthetic identities shared by test client and its isolated backend. */
import { parsePhoneAllowlist } from '../../providers/phoneAllowlist';
let next = 0;
export function phoneFixtureNumber(): string {
  const pool = parsePhoneAllowlist(process.env.CLOUD_IPHONE_ALLOWED_PHONES).filter((phone) =>
    phone.startsWith('+1999')
  );
  const phone = pool[next++];
  if (!phone)
    throw new Error(
      'Run phone cases through scripts/run-blackbox-tests.sh (synthetic identity pool missing)'
    );
  return phone;
}
