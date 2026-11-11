/*
 * A drawn face for an agent, so agents read as someone rather than a letter.
 * The owner can choose the look; otherwise it is derived from the agent, so
 * one agent looks the same everywhere.
 * Colours come from the agent identity tokens; the drawing uses currentColor.
 */
const hairStyles = [
  // short crop
  <path
    key="h"
    d="M11 17.5C11 11.5 15 8 20 8s9 3.5 9 9.5c-2-3-5-4.5-9-4.5s-7 1.5-9 4.5Z"
  />,
  // side swoop
  <path
    key="h"
    d="M10.8 18.5C10.3 11.5 14.8 8 20.3 8c5 0 8.7 3 8.7 8.5-3-1-6-3-8-5.5-2 3.5-6 6-10.2 7.5Z"
  />,
  // top bun
  <g key="h">
    <circle cx="20" cy="6.4" r="3" />
    <path d="M11 17.5C11 11.5 15 8 20 8s9 3.5 9 9.5c-2-3-5-4.5-9-4.5s-7 1.5-9 4.5Z" />
  </g>,
  // curls
  <g key="h">
    <circle cx="12.6" cy="15.4" r="3" />
    <circle cx="14.6" cy="11.4" r="3.2" />
    <circle cx="18.6" cy="9" r="3.2" />
    <circle cx="23" cy="9.4" r="3.2" />
    <circle cx="26.4" cy="12.2" r="3" />
    <circle cx="27.6" cy="16" r="2.6" />
  </g>,
  // close shave
  <path
    key="h"
    d="M11.6 15.5C12.6 11 16 9 20 9s7.4 2 8.4 6.5c-2.4-2.2-5.2-3.2-8.4-3.2s-6 1-8.4 3.2Z"
    opacity="0.55"
  />,
];
const longHair = (
  <path d="M9.6 28C8 17 12 7.6 20 7.6S32 17 30.4 28h-4.2c1-4 .6-9-1-12.4H14.8c-1.6 3.4-2 8.4-1 12.4Z" />
);
const eyeStyles = [
  <g key="e">
    <circle cx="16.6" cy="19" r="1.15" />
    <circle cx="23.4" cy="19" r="1.15" />
  </g>,
  <g key="e" fill="none" stroke="currentColor" strokeWidth="1.5">
    <path d="M15 19.6q1.6-2 3.2 0" />
    <path d="M21.8 19.6q1.6-2 3.2 0" />
  </g>,
  <g key="e">
    <circle cx="16.6" cy="19" r="1.05" />
    <circle cx="23.4" cy="19" r="1.05" />
    <g fill="none" stroke="currentColor" strokeWidth="0.9">
      <circle cx="16.4" cy="19" r="2.7" />
      <circle cx="23.6" cy="19" r="2.7" />
      <path d="M19.1 19h1.8" />
    </g>
  </g>,
];
const mouthStyles = [
  <path key="m" d="M17 23.2q3 2.6 6 0" fill="none" />,
  <path key="m" d="M18 23.6q2 1.5 4 0" fill="none" />,
  <path key="m" d="M17.4 23.2h5.2q-2.6 3.2-5.2 0Z" fill="currentColor" />,
];

export type Look = { hair: number; eyes: number; mouth: number; color: number };

/** How many choices each part of the face has. Hair counts the long style too. */
export const lookOptions = {
  hair: hairStyles.length + 1,
  eyes: eyeStyles.length,
  mouth: mouthStyles.length,
  color: 4,
} as const;

function hash(seed: string) {
  let value = 2166136261;
  for (let index = 0; index < seed.length; index += 1)
    value = Math.imul(value ^ seed.charCodeAt(index), 16777619);
  return value >>> 0;
}

/** The look the owner chose, or a stable one derived from the agent's id and position. */
export function lookFor(
  agent: { id: string; look?: Look },
  index: number,
): Look {
  if (agent.look) return agent.look;
  const value = hash(agent.id);
  return {
    hair: value % lookOptions.hair,
    eyes: (value >>> 4) % lookOptions.eyes,
    mouth: (value >>> 8) % lookOptions.mouth,
    color:
      ((index % lookOptions.color) + lookOptions.color) % lookOptions.color,
  };
}

export function randomLook(): Look {
  const pick = (count: number) => Math.floor(Math.random() * count);
  return {
    hair: pick(lookOptions.hair),
    eyes: pick(lookOptions.eyes),
    mouth: pick(lookOptions.mouth),
    color: pick(lookOptions.color),
  };
}

export function Avatar({
  look,
  large = false,
}: {
  look: Look;
  large?: boolean;
}) {
  const long = look.hair === hairStyles.length;
  return (
    <span
      aria-hidden="true"
      className={`ui-avatar ${large ? "is-lg" : ""} is-agent-${(look.color % lookOptions.color) + 1}`}
    >
      <svg viewBox="5 3 30 30" focusable="false">
        {long && <g fill="currentColor">{longHair}</g>}
        <g
          fill="var(--surface)"
          stroke="currentColor"
          strokeWidth="1.5"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M7 41c0-7.4 5.4-10.6 13-10.6S33 33.6 33 41" />
          <circle cx="20" cy="18.6" r="9" />
          {mouthStyles[look.mouth % mouthStyles.length]}
        </g>
        <g fill="currentColor">
          {long ? hairStyles[0] : hairStyles[look.hair % hairStyles.length]}
          {eyeStyles[look.eyes % eyeStyles.length]}
        </g>
      </svg>
    </span>
  );
}
