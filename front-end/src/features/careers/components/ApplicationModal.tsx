/**
 * STATE MACHINE: ApplicationModal
 *
 * [CLOSED] <-- open: false (controlled by parent)
 *   |
 *   | (parent sets open=true)
 *   v
 * [IDLE] <-- status: 'idle', form editable
 *   |
 *   | (submit with an invalid field)
 *   +--> [IDLE] + inline field error
 *   |
 *   | (submit with every field valid)
 *   v
 * [SUBMITTING] <-- status: 'submitting', inputs disabled
 *   |
 *   +--(request rejected)--> [IDLE] + banner error
 *   |
 *   +--(request accepted)--> [SUBMITTED] <-- status: 'submitted', confirmation shown
 *                              |
 *                              | (modal closed)
 *                              v
 *                            [CLOSED] (form + status reset on next open)
 */

import { useEffect, useRef, useState } from 'react';

import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';

import { LINKEDIN_PREFIX, MAX_RESUME_BYTES, RESUME_MIME_TYPE } from '../config';
import { useSubmitApplication } from '../hooks';

type Status = 'idle' | 'submitting' | 'submitted';

interface FieldErrors {
  name?: string;
  email?: string;
  linkedin?: string;
  resume?: string;
}

interface ApplicationModalProps {
  /** Whether the modal is visible. */
  open: boolean;
  /** Called when the modal requests a visibility change. */
  onOpenChange: (open: boolean) => void;
  /** Slug of the role being applied to. */
  roleSlug: string;
  /** Title of the role, shown in the modal heading. */
  roleTitle: string;
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

function validate(name: string, email: string, linkedin: string, resume: File | null): FieldErrors {
  const errors: FieldErrors = {};
  if (name.trim() === '') errors.name = 'Please enter your name.';
  if (!EMAIL_PATTERN.test(email.trim())) errors.email = 'Please enter a valid email address.';
  if (linkedin.trim() === '') errors.linkedin = 'Please enter your LinkedIn handle.';
  if (resume === null) {
    errors.resume = 'Please attach your resume.';
  } else if (resume.type !== RESUME_MIME_TYPE) {
    errors.resume = 'Resume must be a PDF.';
  } else if (resume.size > MAX_RESUME_BYTES) {
    errors.resume = 'Resume must be under 10MB.';
  }
  return errors;
}

const FIELD_CLASS =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2.5 text-base text-slate-900 placeholder:text-slate-400 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900 disabled:opacity-60';

export default function ApplicationModal({
  open,
  onOpenChange,
  roleSlug,
  roleTitle,
}: ApplicationModalProps) {
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [linkedin, setLinkedin] = useState('');
  const [resume, setResume] = useState<File | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [bannerError, setBannerError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const mountedRef = useRef(true);
  const submitApplication = useSubmitApplication();

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Reset to a clean IDLE form every time the modal is opened.
  useEffect(() => {
    if (!open) return;
    setName('');
    setEmail('');
    setLinkedin('');
    setResume(null);
    setErrors({});
    setBannerError(null);
    setStatus('idle');
  }, [open]);

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (status === 'submitting') return;

    const nextErrors = validate(name, email, linkedin, resume);
    setErrors(nextErrors);
    setBannerError(null);
    if (Object.keys(nextErrors).length > 0 || resume === null) return;

    setStatus('submitting');
    try {
      await submitApplication({
        roleSlug,
        name: name.trim(),
        email: email.trim(),
        linkedin: linkedin.trim(),
        resume,
      });
      if (!mountedRef.current) return;
      setStatus('submitted');
    } catch (error) {
      if (!mountedRef.current) return;
      setStatus('idle');
      setBannerError(
        error instanceof Error
          ? error.message
          : 'Could not submit your application. Please try again.',
      );
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="box-border left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-lg w-[calc(100vw-2rem)] max-w-md max-h-[85svh] sm:max-h-[85vh] overflow-y-auto overflow-x-hidden p-4 sm:p-6">
        <DialogHeader className="text-left min-w-0">
          <DialogTitle className="text-slate-900">
            {status === 'submitted' ? 'Application received' : `Apply — ${roleTitle}`}
          </DialogTitle>
        </DialogHeader>

        {status === 'submitted' ? (
          <div className="space-y-4 min-w-0">
            <p className="text-slate-600 leading-relaxed">
              Thanks for applying. We read every application and will get back to you either way.
            </p>
            <button
              type="button"
              onClick={() => onOpenChange(false)}
              className="w-full rounded-lg bg-navi-black px-4 py-2.5 text-sm font-medium text-white hover:bg-navi-black/90 transition-colors"
            >
              Done
            </button>
          </div>
        ) : (
          <form
            onSubmit={(event) => void handleSubmit(event)}
            className="space-y-4 min-w-0"
            noValidate
          >
            {bannerError !== null && (
              <p role="alert" className="text-sm text-red-600">
                {bannerError}
              </p>
            )}

            <div className="space-y-1.5">
              <label
                htmlFor="application-name"
                className="block text-sm font-medium text-slate-900"
              >
                Name
              </label>
              <input
                id="application-name"
                name="name"
                type="text"
                autoComplete="name"
                value={name}
                disabled={status === 'submitting'}
                onChange={(event) => setName(event.target.value)}
                className={FIELD_CLASS}
              />
              {errors.name !== undefined && <p className="text-sm text-red-600">{errors.name}</p>}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="application-email"
                className="block text-sm font-medium text-slate-900"
              >
                Email
              </label>
              <input
                id="application-email"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                disabled={status === 'submitting'}
                onChange={(event) => setEmail(event.target.value)}
                className={FIELD_CLASS}
              />
              {errors.email !== undefined && <p className="text-sm text-red-600">{errors.email}</p>}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="application-linkedin"
                className="block text-sm font-medium text-slate-900"
              >
                LinkedIn
              </label>
              <div className="flex rounded-lg border border-slate-300 bg-white overflow-hidden focus-within:border-slate-900 focus-within:ring-1 focus-within:ring-slate-900">
                <span className="flex items-center bg-slate-100 px-3 py-2.5 text-sm text-slate-500 border-r border-slate-300 whitespace-nowrap">
                  {LINKEDIN_PREFIX}
                </span>
                <input
                  id="application-linkedin"
                  name="linkedin"
                  type="text"
                  value={linkedin}
                  disabled={status === 'submitting'}
                  onChange={(event) => setLinkedin(event.target.value)}
                  className="min-w-0 flex-1 px-3 py-2.5 text-base text-slate-900 focus:outline-none disabled:opacity-60"
                />
              </div>
              {errors.linkedin !== undefined && (
                <p className="text-sm text-red-600">{errors.linkedin}</p>
              )}
            </div>

            <div className="space-y-1.5">
              <label
                htmlFor="application-resume"
                className="block text-sm font-medium text-slate-900"
              >
                Resume
              </label>
              <input
                id="application-resume"
                name="resume"
                type="file"
                accept="application/pdf"
                disabled={status === 'submitting'}
                onChange={(event) => setResume(event.target.files?.[0] ?? null)}
                className="block w-full min-w-0 text-sm text-slate-600 file:mr-3 file:rounded-md file:border-0 file:bg-slate-900 file:px-4 file:py-2 file:text-sm file:font-medium file:text-white hover:file:bg-slate-800 file:cursor-pointer rounded-lg border border-slate-300 p-2 disabled:opacity-60"
              />
              <p className="text-sm text-slate-500">PDF only, under 10MB.</p>
              {errors.resume !== undefined && (
                <p className="text-sm text-red-600">{errors.resume}</p>
              )}
            </div>

            <button
              type="submit"
              disabled={status === 'submitting'}
              className="w-full rounded-lg bg-navi-black px-4 py-2.5 text-sm font-medium text-white hover:bg-navi-black/90 transition-colors disabled:opacity-60"
            >
              {status === 'submitting' ? 'Submitting…' : 'Submit application'}
            </button>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
