/**
 * STATE MACHINE: RoseAppDrawers
 *
 * Everything in the right-panel slot stays mounted (portaled to <body>) so it
 * can slide in/out; exactly one is open at a time (RoseAppsProvider.openApp):
 *   'browser'                                   -> BrowserAppDrawer (full width)
 *   'integrations' | 'benchmarks' | 'feedback' | 'settings' -> RoseAppPanelDrawer
 *   'phone'                                     -> PhoneApp (floating device)
 *   null                                        -> all closed
 */

import { ValidationCriteriaDrawer } from './ValidationCriteriaDrawer';
import { BrowserAppDrawer } from './BrowserAppDrawer';
import { PhoneApp } from './PhoneApp';
import { RoseAppPanelDrawer } from './RoseAppPanels';

export function RoseAppDrawers() {
  return (
    <>
      <BrowserAppDrawer />
      <ValidationCriteriaDrawer />
      <RoseAppPanelDrawer />
      <PhoneApp />
    </>
  );
}
