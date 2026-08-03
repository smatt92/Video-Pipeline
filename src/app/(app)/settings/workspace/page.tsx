import { Panel, Row, SectionHeader } from '@/components/settings/parts';
import { UiScaleControl } from '@/components/settings/ui-scale-control';
import { readUiScale } from '@/lib/settings/read-ui-scale';

/**
 * Workspace — the settings about looking at Kiln rather than about running it.
 *
 * Display scale is here rather than under an accessibility heading on purpose. It is not a
 * remediation; it is the same control VS Code, Figma and Zed put in their main settings,
 * and burying it under "accessibility" makes the person with a 4K monitor look in the wrong
 * place for a problem they would describe as "everything is tiny".
 */

export const dynamic = 'force-dynamic';

export const metadata = { title: 'Kiln — workspace' };

export default async function WorkspacePage() {
  const uiScale = await readUiScale();

  return (
    <>
      <SectionHeader
        title="Workspace"
        hint="How Kiln looks on this account. Persisted to your profile, so it is applied before the first paint on every device you sign in from."
      />

      <Panel>
        <Row
          label="Display scale"
          help="Multiplies every size and spacing in the interface. A 4K monitor at 100% OS scaling reports a 3840px CSS viewport, so the browser believes the window really is that wide and renders text at its true, tiny, correct size. Nothing can infer how far away the screen is — only you know that."
        >
          <UiScaleControl current={uiScale} />
        </Row>

        <Row
          label="Text size"
          help="Kiln's type is set in rem and scales with your browser's font-size setting as well. Browser zoom and this control compose — use whichever is closer to hand."
        >
          <p className="text-xs leading-snug" style={{ color: 'var(--text-muted)' }}>
            Nothing to set here. It follows the browser.
          </p>
        </Row>

        <Row
          label="Not built yet"
          help="This section will also hold the workspace name, the default channel and the USD→INR rate. None of those exist yet; the FX rate currently comes from the environment and onboarding step 1."
        >
          <p className="text-xs leading-snug" style={{ color: 'var(--text-faint)' }}>
            Listed so the gap is visible rather than implied by an empty page.
          </p>
        </Row>
      </Panel>
    </>
  );
}
