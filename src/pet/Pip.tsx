import type { PetPose } from "./usePetState";

type Props = {
  pose: PetPose;
  reducedMotion: boolean;
};

/**
 * Pip: an original chibi sticky-note sticker. One chubby silhouette with a
 * folded corner, big glinted eyes, blush, and stubby arms and feet.
 */
export default function Pip({ pose, reducedMotion }: Props) {
  const still = reducedMotion ? " pip-still" : "";
  const worried = pose === "worried";
  const ready = pose === "ready";
  const working = pose === "working";
  const waving = pose === "waving";
  const eyeY = working ? 21.6 : 20.5;

  return (
    <svg className={`pip pose-${pose}${still}`} viewBox="0 0 44 44" aria-hidden>
      <ellipse className="pip-shadow" cx="22" cy="42" rx="10" ry="1.8" />
      <g className="pip-body">
        <rect className="pip-outline" x="13" y="35" width="7.6" height="6.4" rx="3.2" />
        <rect className="pip-outline" x="23.4" y="35" width="7.6" height="6.4" rx="3.2" />
        <rect className="pip-paper" x="14.1" y="36.1" width="5.4" height="4.2" rx="2.1" />
        <rect className="pip-paper" x="24.5" y="36.1" width="5.4" height="4.2" rx="2.1" />
        {waving ? (
          <g className="pip-wavearm">
            <rect className="pip-outline" x="36" y="8" width="6.6" height="12" rx="3.3" transform="rotate(24 39.3 14)" />
            <rect className="pip-paper" x="37.1" y="9.1" width="4.4" height="9.8" rx="2.2" transform="rotate(24 39.3 14)" />
          </g>
        ) : (
          <g>
            <rect className="pip-outline" x="1.6" y="21.5" width="7" height="6.2" rx="3.1" transform="rotate(18 5.1 24.6)" />
            <rect className="pip-paper" x="2.7" y="22.6" width="4.8" height="4" rx="2" transform="rotate(18 5.1 24.6)" />
            <rect className="pip-outline" x="35.4" y="21.5" width="7" height="6.2" rx="3.1" transform="rotate(-18 38.9 24.6)" />
            <rect className="pip-paper" x="36.5" y="22.6" width="4.8" height="4" rx="2" transform="rotate(-18 38.9 24.6)" />
          </g>
        )}
        <path
          className="pip-outline"
          d="M15.5 4.6 H26.8 L41 18.8 V27.4 Q41 39.4 27.4 39.4 H16.6 Q3 39.4 3 27.4 V17 Q3 4.6 15.5 4.6 Z"
        />
        <path
          className="pip-paper"
          d="M15.8 6.3 H26.1 L39.3 19.5 V27.2 Q39.3 37.7 27.2 37.7 H16.8 Q4.7 37.7 4.7 27.2 V17 Q4.7 6.3 15.8 6.3 Z"
        />
        <path
          className="pip-shade"
          d="M5.6 30 Q7.6 37.7 16.8 37.7 H27.2 Q36.4 37.7 38.4 30 Q33 33.4 22 33.4 Q11 33.4 5.6 30 Z"
        />
        <path className="pip-outline" d="M26.8 4.6 L41 18.8 H31.3 Q26.8 18.8 26.8 14.3 Z" />
        <path className="pip-fold" d="M28.5 8.6 L37 17.1 H31.3 Q28.5 17.1 28.5 14.3 Z" />
        <ellipse className="pip-shine" cx="13.4" cy="10.8" rx="4.6" ry="2.2" transform="rotate(-18 13.4 10.8)" />
        <g className="pip-face">
          <ellipse className="pip-blush" cx="12.6" cy="25.8" rx="2.5" ry="1.5" />
          <ellipse className="pip-blush" cx="31.4" cy="25.8" rx="2.5" ry="1.5" />
          {ready ? (
            <g>
              <path className="pip-stroke" d="M13.6 21.2 q2.4 -3 4.8 0" />
              <path className="pip-stroke" d="M25.6 21.2 q2.4 -3 4.8 0" />
              <path className="pip-stroke" d="M19.2 25.2 q2.8 3.1 5.6 0" />
            </g>
          ) : worried ? (
            <g>
              <ellipse className="pip-eye" cx="16" cy="21" rx="2.3" ry="1.9" />
              <ellipse className="pip-eye" cx="28" cy="21" rx="2.3" ry="1.9" />
              <circle className="pip-glint" cx="15.2" cy="20.2" r="0.8" />
              <circle className="pip-glint" cx="27.2" cy="20.2" r="0.8" />
              <path className="pip-stroke" d="M13.2 17.2 l5 1.4" />
              <path className="pip-stroke" d="M30.8 17.2 l-5 1.4" />
              <path className="pip-stroke" d="M19.6 26.6 q2.4 -1.8 4.8 0" />
            </g>
          ) : (
            <g>
              <g className="pip-eyes">
                <circle className="pip-eye" cx="16" cy={eyeY} r="2.6" />
                <circle className="pip-eye" cx="28" cy={eyeY} r="2.6" />
                <circle className="pip-glint" cx="15.1" cy={eyeY - 0.9} r="0.9" />
                <circle className="pip-glint" cx="27.1" cy={eyeY - 0.9} r="0.9" />
              </g>
              {working ? (
                <path className="pip-stroke" d="M20 26.4 h4" />
              ) : (
                <path className="pip-stroke" d="M19.6 25 q2.4 2.6 4.8 0" />
              )}
            </g>
          )}
        </g>
        {working ? (
          <g className="pip-pencil">
            <rect className="pip-outline" x="29.5" y="24.8" width="12.4" height="5" rx="1.4" transform="rotate(32 35.7 27.3)" />
            <rect className="pip-pencil-wood" x="30.6" y="25.9" width="8" height="2.8" rx="0.9" transform="rotate(32 35.7 27.3)" />
            <path className="pip-pencil-tip" d="M41.6 31.4 l2.8 2.4 -3.6 0.6 Z" />
          </g>
        ) : null}
        {worried ? (
          <path className="pip-sweat" d="M8.3 9.6 q-1.5 2.2 0 3.4 q1.5 -1.2 0 -3.4" />
        ) : null}
        {ready ? (
          <g className="pip-badge">
            <circle className="pip-badge-dot" cx="37" cy="35" r="4.6" />
            <path className="pip-badge-mark" d="M34.9 35.1 l1.5 1.5 2.7 -3" />
          </g>
        ) : null}
      </g>
    </svg>
  );
}
