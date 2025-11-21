declare module 'node-mac-contacts' {
  export type OptionalProperty =
    | 'jobTitle'
    | 'departmentName'
    | 'organizationName'
    | 'middleName'
    | string;

  export interface MacContact {
    identifier: string;
    firstName?: string;
    lastName?: string;
    middleName?: string;
    nickname?: string;
    organizationName?: string;
    jobTitle?: string;
    departmentName?: string;
    phoneNumbers?: string[];
    emailAddresses?: string[];
  }

  export function getAllContacts(props?: OptionalProperty[]): MacContact[];
  export function getAuthStatus(): string;
}

