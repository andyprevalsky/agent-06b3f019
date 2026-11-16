/**
 * STATE MACHINE: ToolIntegrationSections (stateless)
 *
 *   [MOUNTED, signed in] --> CLIs card · MCP servers card, each in its own
 *     SearchGroup (hidden, not unmounted, when search does not match)
 *
 * Shared by the stock page (IntegrationSections) and Rose Desktop
 * (DesktopIntegrations), right after GitHub Repos; each card owns its hook.
 */
import CliIntegrationsSection from './CliIntegrationsSection';
import SearchGroup from './IntegrationSearchGroup';
import McpServersSection from './McpServersSection';

export default function ToolIntegrationSections({
  search,
  desktop = false,
}: {
  search: string;
  desktop?: boolean;
}) {
  const spacing = desktop ? 'my-3' : undefined;
  return (
    <>
      <SearchGroup catalogKey="clis" search={search}>
        <div className={spacing}>
          <CliIntegrationsSection />
        </div>
      </SearchGroup>
      <SearchGroup catalogKey="mcp" search={search}>
        <div className={spacing}>
          <McpServersSection />
        </div>
      </SearchGroup>
    </>
  );
}
