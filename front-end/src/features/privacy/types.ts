/** A single bullet point within a privacy policy section. */
export interface PrivacyBullet {
  readonly text: string;
}

/** A section of the privacy policy (numbered heading + content). */
export interface PrivacySection {
  readonly number: number;
  readonly title: string;
  readonly bullets?: readonly PrivacyBullet[];
  readonly paragraph?: string;
}
