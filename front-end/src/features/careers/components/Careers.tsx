/**
 * STATE MACHINE: Careers (overview page)
 *
 * This component is stateless - it renders the company thesis, every open
 * role as a card linking to /careers/:slug, how we work, and compensation.
 *
 * [MOUNTED] --> renders overview
 */

import { Link } from 'react-router-dom';
import NaviFooter from '@/components/NaviFooter';

import { ABOUT_ROSE, FONT_FAMILY, JOB_TYPE, LOCATION, WORK_STYLE } from '../config';
import { useRoles } from '../hooks';

import CareersHeader from './CareersHeader';

export default function Careers() {
  const roles = useRoles();
  const totalOpenings = roles.reduce((sum, role) => sum + role.openings, 0);

  return (
    <main
      className="min-h-screen bg-white text-slate-900 flex flex-col"
      style={{ fontFamily: FONT_FAMILY }}
    >
      <CareersHeader />

      <div className="max-w-3xl mx-auto px-6 py-12 sm:py-16 flex-1 w-full space-y-12 sm:space-y-16">
        <header className="space-y-4">
          <p className="text-sm uppercase tracking-wide text-slate-500">Careers</p>
          <h1 className="text-3xl sm:text-5xl font-semibold tracking-tight leading-tight">
            Agent scale is the bottleneck to superintelligence. We&rsquo;re hiring {totalOpenings}{' '}
            engineers to break it.
          </h1>
          <p className="text-base sm:text-lg text-slate-600 leading-relaxed">
            {LOCATION} · {WORK_STYLE} · {JOB_TYPE}
          </p>
        </header>

        <section className="space-y-4">
          {ABOUT_ROSE.map((paragraph) => (
            <p key={paragraph.slice(0, 40)} className="text-base text-slate-600 leading-relaxed">
              {paragraph}
            </p>
          ))}
        </section>

        <section className="space-y-4">
          <h2 className="text-xl font-semibold text-slate-900">Open roles</h2>
          <div className="space-y-4">
            {roles.map((role) => (
              <Link key={role.slug} to={`/careers/${role.slug}`} className="block group">
                <article className="p-6 rounded-lg bg-slate-50 hover:bg-slate-100 transition-colors space-y-2">
                  <h3 className="text-lg sm:text-xl font-semibold text-slate-900 group-hover:text-slate-700 transition-colors leading-tight">
                    {role.title}
                  </h3>
                  <p className="text-base text-slate-600 leading-relaxed">{role.summary}</p>
                  <p className="text-sm text-slate-500">
                    <span className="text-slate-600">{role.discipline}</span>
                    <span className="mx-2">·</span>
                    {role.openings === 1 ? '1 opening' : `${role.openings} openings`}
                    <span className="mx-2">·</span>
                    {LOCATION}
                  </p>
                </article>
              </Link>
            ))}
          </div>
        </section>
      </div>

      <NaviFooter />
    </main>
  );
}
