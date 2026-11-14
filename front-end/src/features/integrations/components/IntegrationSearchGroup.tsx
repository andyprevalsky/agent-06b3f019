/**
 * STATE MACHINE: IntegrationSearchGroup (stateless)
 *
 *   [MATCHES search] --> children visible
 *   [NO MATCH]      --> children stay mounted but hidden, so their state survives
 *                       while the Integrations search box narrows the list
 */
import type { ReactNode } from 'react';

import { integrationMatchesSearch } from '../hooks/integrationSearch';
import type { IntegrationCatalogKey } from '../types';

export default function IntegrationSearchGroup({
  catalogKey,
  search,
  children,
}: {
  catalogKey: IntegrationCatalogKey;
  search: string;
  children: ReactNode;
}) {
  return <div hidden={!integrationMatchesSearch(catalogKey, search)}>{children}</div>;
}
