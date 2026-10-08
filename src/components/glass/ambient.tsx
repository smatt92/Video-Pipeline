/**
 * The ambient layer (Kiln Glass): three drifting orbs in the theme's glow colours, the
 * generating glow, the one-shot red pulse and a static grain tile. Fixed behind every screen;
 * the nearest `data-glow` decides which of them show (glass.css). Decorative, so hidden from
 * assistive tech, and stilled by reduced motion. Used by the app shell and the setup frame.
 */
export function Ambient() {
  return (
    <>
      <div className="amb" aria-hidden="true">
        <i className="o1" />
        <i className="o2" />
        <i className="o3" />
        <i className="o4" />
      </div>
      <div className="redp" aria-hidden="true" />
      <div className="grain" aria-hidden="true" />
    </>
  );
}
