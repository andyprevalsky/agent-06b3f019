/** A submitted job application, as received from the careers page. */
export interface JobApplicationInput {
  /** Slug of the role applied to, e.g. "founding-product-engineer". */
  roleSlug: string;
  /** Applicant's full name. */
  name: string;
  /** Applicant's email address. */
  email: string;
  /** LinkedIn handle or URL as typed by the applicant. */
  linkedin: string;
  /** Uploaded resume. */
  resume: {
    filename: string;
    mimeType: string;
    content: Buffer;
  };
}

/** Outcome of notifying the hiring recipients about an application. */
export interface JobApplicationResult {
  success: true;
  /** Recipients the relay accepted the notification for. */
  notified: string[];
  /** Recipients the relay rejected. Non-empty means partial delivery. */
  failed: string[];
}
