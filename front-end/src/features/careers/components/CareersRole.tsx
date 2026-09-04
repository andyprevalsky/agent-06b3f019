/**
 * STATE MACHINE: CareersRole (role detail page)
 *
 * [MOUNTED]
 *   |
 *   +--(slug matches no role)--> renders the "Role not found" fallback
 *   |
 *   +--(slug matches a role)--> [VIEWING] <-- applyOpen: false
 *                                  |
 *                                  | (click "Apply for this role")
 *                                  v
 *                               [APPLYING] <-- applyOpen: true, ApplicationModal owns
 *                                              its own idle/submitting/submitted states
 *                                  |
 *                                  | (modal closed)
 *                                  v
 *                               [VIEWING]
 */

import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import NaviFooter from '@/components/NaviFooter';

import { FONT_FAMILY, JOB_TYPE, LOCATION, WORK_STYLE } from '../config';
import { useRole } from '../hooks';

import ApplicationModal from './ApplicationModal';
import CareersHeader from './CareersHeader';
import CompensationBlock from './CompensationBlock';

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <p className="text-xs uppercase tracking-wide text-slate-500">{label}</p>
      <p className="text-base text-slate-900">{value}</p>
    </div>
  );
}

export default function CareersRole() {
  const { slug } = useParams<{ slug: string }>();
  const role = useRole(slug);
  const [applyOpen, setApplyOpen] = useState(false);

  if (role === undefined) {
    return (
      <main
        className="min-h-screen bg-white text-slate-900 flex flex-col"
        style={{ fontFamily: FONT_FAMILY }}
      >
        <CareersHeader showBackLink />
        <div className="max-w-3xl mx-auto px-6 py-16 flex-1 w-full space-y-4">
          <h1 className="text-3xl font-semibold tracking-tight">Role not found</h1>
          <p className="text-base text-slate-600">
            That role is not open. See all{' '}
            <Link to="/careers" className="underline hover:text-slate-900">
              open roles
            </Link>
            .
          </p>
        </div>
        <NaviFooter />
      </main>
    );
  }

  return (
    <main
      className="min-h-screen bg-white text-slate-900 flex flex-col"
      style={{ fontFamily: FONT_FAMILY }}
    >
      <CareersHeader showBackLink />

      <article className="max-w-3xl mx-auto px-6 py-12 sm:py-16 flex-1 w-full space-y-12">
        <header className="space-y-6">
          <div className="space-y-3">
            <p className="text-sm uppercase tracking-wide text-slate-500">{role.discipline}</p>
            <h1 className="text-3xl sm:text-4xl font-semibold tracking-tight leading-tight">
              {role.title}
            </h1>
            <p className="text-base text-slate-600">
              {role.openings === 1 ? '1 opening' : `${role.openings} openings`}
            </p>
          </div>

          <div className="grid grid-cols-2 sm:grid-cols-3 gap-4 sm:gap-6 rounded-lg bg-slate-50 p-6">
            <MetaItem label="Job type" value={JOB_TYPE} />
            <MetaItem label="Work style" value={WORK_STYLE} />
            <MetaItem label="Location" value={LOCATION} />
          </div>

          <button
            type="button"
            onClick={() => setApplyOpen(true)}
            className="w-full sm:w-auto rounded-lg bg-navi-black px-6 py-3 text-sm font-medium text-white hover:bg-navi-black/90 transition-colors"
          >
            Apply for this role
          </button>
        </header>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold text-slate-900">About the Role</h2>
          {role.about.map((paragraph) => (
            <p key={paragraph.slice(0, 40)} className="text-base text-slate-600 leading-relaxed">
              {paragraph}
            </p>
          ))}
        </section>

        {role.sections.map((section) => (
          <section key={section.title} className="space-y-4">
            <h2 className="text-xl font-semibold text-slate-900">{section.title}</h2>
            {section.body?.map((paragraph) => (
              <p key={paragraph.slice(0, 40)} className="text-base text-slate-600 leading-relaxed">
                {paragraph}
              </p>
            ))}
            {section.bullets !== undefined && (
              <ul className="space-y-3">
                {section.bullets.map((bullet) => (
                  <li
                    key={bullet.slice(0, 40)}
                    className="flex gap-3 text-base text-slate-600 leading-relaxed"
                  >
                    <span aria-hidden="true" className="text-slate-400 flex-shrink-0">
                      &middot;
                    </span>
                    <span>{bullet}</span>
                  </li>
                ))}
              </ul>
            )}
          </section>
        ))}

        <CompensationBlock />

        <div>
          <button
            type="button"
            onClick={() => setApplyOpen(true)}
            className="w-full sm:w-auto rounded-lg bg-navi-black px-6 py-3 text-sm font-medium text-white hover:bg-navi-black/90 transition-colors"
          >
            Apply for this role
          </button>
        </div>
      </article>

      <ApplicationModal
        open={applyOpen}
        onOpenChange={setApplyOpen}
        roleSlug={role.slug}
        roleTitle={role.title}
      />

      <NaviFooter />
    </main>
  );
}
