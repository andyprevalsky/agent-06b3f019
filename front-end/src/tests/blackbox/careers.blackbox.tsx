import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { Route, Routes } from 'react-router-dom';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import {
  Careers,
  ApplicationModal,
  CompensationBlock,
  ROLES,
  ABOUT_ROSE,
  HOW_WE_WORK,
  COMPENSATION,
  LOCATION,
  findRole,
  submitApplication,
  CareersRole,
} from '@/features/careers';

// ---------------------------------------------------------------------------
// Content contract — the catalog every careers surface renders from
// ---------------------------------------------------------------------------

describe('careers content', () => {
  it('publishes three roles', () => {
    expect(ROLES).toHaveLength(3);
  });

  it('gives every role a unique slug', () => {
    const slugs = ROLES.map((role) => role.slug);
    expect(new Set(slugs).size).toBe(slugs.length);
  });

  it('gives every role the fields the detail page renders', () => {
    for (const role of ROLES) {
      expect(role.title).not.toBe('');
      expect(role.discipline).not.toBe('');
      expect(role.summary).not.toBe('');
      expect(role.openings).toBeGreaterThan(0);
      expect(role.about.length).toBeGreaterThan(0);
      expect(role.sections.length).toBeGreaterThan(0);
      for (const section of role.sections) {
        expect(section.title).not.toBe('');
        expect((section.bullets?.length ?? 0) + (section.body?.length ?? 0)).toBeGreaterThan(0);
      }
    }
  });

  it('hires two harness engineers and one of each other role', () => {
    const openings = Object.fromEntries(ROLES.map((role) => [role.slug, role.openings]));
    expect(openings['founding-research-engineer-agent-harness']).toBe(2);
    expect(ROLES.reduce((sum, role) => sum + role.openings, 0)).toBe(4);
  });

  it('resolves a known slug and rejects an unknown one', () => {
    expect(findRole(ROLES[0].slug)?.title).toBe(ROLES[0].title);
    expect(findRole('not-a-real-role')).toBeUndefined();
    expect(findRole(undefined)).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Overview page — /careers
// ---------------------------------------------------------------------------

describe('Careers overview page', () => {
  it('renders every open role as a link to its detail page', () => {
    renderWithProviders(<Careers />);
    for (const role of ROLES) {
      const link = screen.getByRole('link', {
        name: new RegExp(role.title.replace(/&/g, '&'), 'i'),
      });
      expect(link).toHaveAttribute('href', `/careers/${role.slug}`);
    }
  });

  it('states the total number of openings in the headline', () => {
    renderWithProviders(<Careers />);
    expect(screen.getByRole('heading', { level: 1 }).textContent).toContain('4 engineers');
  });

  it('renders the company thesis and how-we-work copy', () => {
    renderWithProviders(<Careers />);
    expect(screen.getByText(ABOUT_ROSE[0])).toBeInTheDocument();
    for (const item of HOW_WE_WORK) {
      expect(screen.getByText(item)).toBeInTheDocument();
    }
  });

  it('leads with total cash, not base', () => {
    renderWithProviders(<Careers />);
    expect(screen.getByText(COMPENSATION.totalCash)).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Role detail page — /careers/:slug
// ---------------------------------------------------------------------------

function renderRolePage(slug: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/careers/:slug" element={<CareersRole />} />
    </Routes>,
    { route: `/careers/${slug}` },
  );
}

describe('CareersRole detail page', () => {
  it.each(ROLES.map((role) => [role.slug, role.title] as const))(
    'renders %s with its full description',
    (slug, title) => {
      renderRolePage(slug);
      expect(screen.getByRole('heading', { level: 1, name: title })).toBeInTheDocument();
      const role = findRole(slug)!;
      for (const section of role.sections) {
        expect(screen.getByRole('heading', { name: section.title })).toBeInTheDocument();
      }
      for (const bullet of role.sections.flatMap((section) => section.bullets ?? [])) {
        expect(screen.getByText(bullet)).toBeInTheDocument();
      }
    },
  );

  it('falls back to NotFound for an unknown slug', () => {
    renderRolePage('not-a-real-role');
    expect(
      screen.queryByRole('heading', { level: 1, name: ROLES[0].title }),
    ).not.toBeInTheDocument();
  });

  it('shows the job type, work style, and location meta block', () => {
    renderRolePage(ROLES[0].slug);
    expect(screen.getByText('Job type')).toBeInTheDocument();
    expect(screen.getByText('Work style')).toBeInTheDocument();
    expect(screen.getAllByText(LOCATION).length).toBeGreaterThan(0);
  });

  it('opens the application form from the apply button', async () => {
    const user = userEvent.setup();
    renderRolePage(ROLES[0].slug);
    await user.click(screen.getAllByRole('button', { name: /apply for this role/i })[0]);
    expect(await screen.findByLabelText('Name')).toBeInTheDocument();
    expect(screen.getByLabelText('Email')).toBeInTheDocument();
    expect(screen.getByLabelText('LinkedIn')).toBeInTheDocument();
    expect(screen.getByLabelText('Resume')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Compensation block
// ---------------------------------------------------------------------------

describe('CompensationBlock', () => {
  it('renders total cash, breakdown, equity, and location', () => {
    renderWithProviders(<CompensationBlock />);
    expect(screen.getByText(COMPENSATION.totalCash)).toBeInTheDocument();
    expect(screen.getByText(new RegExp(COMPENSATION.equity, 'i'))).toBeInTheDocument();
    expect(screen.getByText(new RegExp(LOCATION, 'i'))).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Application form — validation + submission state machine
// ---------------------------------------------------------------------------

function pdf(name = 'resume.pdf', size = 1024): File {
  const file = new File(['x'], name, { type: 'application/pdf' });
  Object.defineProperty(file, 'size', { value: size });
  return file;
}

function applicationPosts(): unknown[][] {
  const mock = globalThis.fetch as ReturnType<typeof vi.fn>;
  return mock.mock.calls.filter((call) => String(call[0]).includes('/careers/applications'));
}

function renderForm() {
  return renderWithProviders(
    <ApplicationModal
      open
      onOpenChange={() => {}}
      roleSlug={ROLES[0].slug}
      roleTitle={ROLES[0].title}
    />,
  );
}

describe('ApplicationModal', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({}) }));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('collects exactly name, email, linkedin, and resume', () => {
    renderForm();
    const form = screen.getByRole('button', { name: /submit application/i }).closest('form')!;
    const fields = within(form)
      .getAllByLabelText(/.*/)
      .map((el) => el.getAttribute('name'))
      .filter((n): n is string => n !== null);
    expect(new Set(fields)).toEqual(new Set(['name', 'email', 'linkedin', 'resume']));
  });

  it('blocks submission and reports every empty field', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.click(screen.getByRole('button', { name: /submit application/i }));
    expect(await screen.findByText('Please enter your name.')).toBeInTheDocument();
    expect(screen.getByText('Please enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Please enter your LinkedIn handle.')).toBeInTheDocument();
    expect(screen.getByText('Please attach your resume.')).toBeInTheDocument();
    expect(applicationPosts()).toHaveLength(0);
  });

  it('rejects a malformed email', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.click(screen.getByRole('button', { name: /submit application/i }));
    expect(await screen.findByText('Please enter a valid email address.')).toBeInTheDocument();
    expect(applicationPosts()).toHaveLength(0);
  });

  it('rejects a resume over 10MB', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.upload(screen.getByLabelText('Resume'), pdf('big.pdf', 11 * 1024 * 1024));
    await user.click(screen.getByRole('button', { name: /submit application/i }));
    expect(await screen.findByText('Resume must be under 10MB.')).toBeInTheDocument();
    expect(applicationPosts()).toHaveLength(0);
  });

  it('rejects a non-PDF resume', async () => {
    const user = userEvent.setup();
    renderForm();
    const docx = new File(['x'], 'resume.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    // accept="application/pdf" filters this in the picker, so drive the change
    // event directly -- drag-drop and "All Files" bypass accept, which is the
    // path this validation exists for.
    fireEvent.change(screen.getByLabelText('Resume'), { target: { files: [docx] } });
    await user.click(screen.getByRole('button', { name: /submit application/i }));
    expect(await screen.findByText('Resume must be a PDF.')).toBeInTheDocument();
    expect(applicationPosts()).toHaveLength(0);
  });

  it('posts every field and confirms on success', async () => {
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Name'), 'Ada Lovelace');
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('LinkedIn'), 'adalovelace');
    await user.upload(screen.getByLabelText('Resume'), pdf());
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    await waitFor(() => {
      expect(applicationPosts()).toHaveLength(1);
    });
    const [url, init] = applicationPosts()[0] as [string, RequestInit];
    expect(String(url)).toMatch(/\/careers\/applications$/);
    expect(init.method).toBe('POST');
    const body = init.body as FormData;
    expect(body.get('role_slug')).toBe(ROLES[0].slug);
    expect(body.get('name')).toBe('Ada Lovelace');
    expect(body.get('email')).toBe('ada@example.com');
    expect(body.get('linkedin')).toBe('adalovelace');
    expect((body.get('resume') as File).name).toBe('resume.pdf');

    expect(await screen.findByText(/application received/i)).toBeInTheDocument();
  });

  it('surfaces the backend error and stays editable on failure', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, json: async () => ({ error: 'Role is closed.' }) }),
    );
    const user = userEvent.setup();
    renderForm();
    await user.type(screen.getByLabelText('Name'), 'Ada Lovelace');
    await user.type(screen.getByLabelText('Email'), 'ada@example.com');
    await user.type(screen.getByLabelText('LinkedIn'), 'adalovelace');
    await user.upload(screen.getByLabelText('Resume'), pdf());
    await user.click(screen.getByRole('button', { name: /submit application/i }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Role is closed.');
    expect(screen.getByRole('button', { name: /submit application/i })).toBeEnabled();
  });
});

// ---------------------------------------------------------------------------
// API client
// ---------------------------------------------------------------------------

describe('submitApplication', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('throws a generic message when the backend gives no detail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) }));
    await expect(
      submitApplication({
        roleSlug: ROLES[0].slug,
        name: 'A',
        email: 'a@b.co',
        linkedin: 'a',
        resume: pdf(),
      }),
    ).rejects.toThrow(/could not submit your application/i);
  });
});
