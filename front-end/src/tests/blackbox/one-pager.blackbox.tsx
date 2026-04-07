import { describe, it, expect } from 'vitest';
import { screen, waitFor } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import OnePager from '@/pages/OnePager';

describe('OnePager page', () => {
  // ---------------------------------------------------------------------------
  // Rendering: page title, tagline, section headings
  // ---------------------------------------------------------------------------

  it('renders Rose Labs heading', () => {
    renderWithProviders(<OnePager />);
    expect(screen.getByRole('heading', { name: /rose labs/i })).toBeInTheDocument();
  });

  it('renders tagline about frontier research', () => {
    renderWithProviders(<OnePager />);
    expect(
      screen.getByText(/frontier research for agentic superintelligence/i),
    ).toBeInTheDocument();
  });

  it('renders all section headings', () => {
    renderWithProviders(<OnePager />);

    const expectedHeadings = [
      /why mass agent networks are the evolutionary leap/i,
      /why mans lead to superintelligence/i,
      /what we built in less than 60 days/i,
      /vision/i,
      /founders/i,
      /raise/i,
      /contact/i,
    ];

    for (const name of expectedHeadings) {
      expect(screen.getByRole('heading', { name })).toBeInTheDocument();
    }
  });

  // ---------------------------------------------------------------------------
  // Content: intro, MANs bullets, "What We Built" items
  // ---------------------------------------------------------------------------

  it('renders intro paragraphs about Mass Agent Networks', () => {
    renderWithProviders(<OnePager />);
    expect(
      screen.getByText(/pioneering/i),
    ).toBeInTheDocument();
    // "Mass Agent Networks" appears in multiple places
    expect(screen.getAllByText(/mass agent networks/i).length).toBeGreaterThanOrEqual(2);
  });

  it('renders MANs characteristic bullet points', () => {
    renderWithProviders(<OnePager />);
    expect(screen.getByText(/divide complex tasks into small tractable components/i)).toBeInTheDocument();
    expect(screen.getByText(/keep context small where models perform best/i)).toBeInTheDocument();
    expect(screen.getByText(/run thousands of reasoning paths in parallel/i)).toBeInTheDocument();
    expect(screen.getByText(/cross verify each other/i)).toBeInTheDocument();
    expect(screen.getByText(/self organize into higher order structures/i)).toBeInTheDocument();
  });

  it('renders "Why MANs Lead to Superintelligence" content', () => {
    renderWithProviders(<OnePager />);
    expect(screen.getByText(/small agent networks explore too slowly/i)).toBeInTheDocument();
    expect(screen.getByText(/monolithic models explore too shallowly/i)).toBeInTheDocument();
    expect(
      screen.getByText(/generate and evaluate thousands of hypotheses in parallel/i),
    ).toBeInTheDocument();
  });

  it('renders "What We Built" numbered items', () => {
    renderWithProviders(<OnePager />);
    expect(screen.getByText(/full stack product/i)).toBeInTheDocument();
    expect(screen.getByText(/a new model competitive with major labs/i)).toBeInTheDocument();
    expect(screen.getByText(/foundational research breakthroughs/i)).toBeInTheDocument();
    expect(screen.getByText(/prompt braiding/i)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Content: Vision section
  // ---------------------------------------------------------------------------

  it('renders Vision section content', () => {
    renderWithProviders(<OnePager />);
    expect(screen.getByText(/within a decade/i)).toBeInTheDocument();
    expect(
      screen.getByText(/first billion \/ trillion agent systems/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/rose labs is building the foundation for this architecture/i),
    ).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Content: Founders section
  // ---------------------------------------------------------------------------

  it('renders Andy Prevalsky details', () => {
    renderWithProviders(<OnePager />);
    expect(screen.getByText(/andy prevalsky/i)).toBeInTheDocument();
    expect(screen.getByText(/built hotplate from zero to pmf/i)).toBeInTheDocument();
    expect(screen.getByText(/5m arr/i)).toBeInTheDocument();
    expect(screen.getByText(/sole engineer at hotplate/i)).toBeInTheDocument();
    expect(screen.getByText(/ex google and meta ai/i)).toBeInTheDocument();
    // Michael Seibel appears twice (backed by + mentored by)
    expect(screen.getAllByText(/michael seibel/i)).toHaveLength(2);
    expect(screen.getByText(/connie chan at a16z/i)).toBeInTheDocument();
  });

  it('renders Aaditya Shidham details', () => {
    renderWithProviders(<OnePager />);
    expect(screen.getByText(/aaditya shidham/i)).toBeInTheDocument();
    expect(screen.getByText(/previously invested at a16z/i)).toBeInTheDocument();
    expect(screen.getByText(/mpc web3 wallet at coinbase/i)).toBeInTheDocument();
    expect(screen.getByText(/protocol labs.*635k users/i)).toBeInTheDocument();
    expect(screen.getByText(/stanford cs undergrad/i)).toBeInTheDocument();
    expect(screen.getByText(/thiel fellow finalist/i)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Content: Raise section
  // ---------------------------------------------------------------------------

  it('renders funding amount and raise details', () => {
    renderWithProviders(<OnePager />);
    expect(screen.getByText('$3M')).toBeInTheDocument();
    expect(screen.getByText(/hire engineers, acquire gpus/i)).toBeInTheDocument();
    expect(screen.getByText(/connect us with customers/i)).toBeInTheDocument();
    expect(screen.getByText(/help us hire top talent/i)).toBeInTheDocument();
    expect(screen.getByText(/deep expertise in ai, infra/i)).toBeInTheDocument();
  });

  // ---------------------------------------------------------------------------
  // Navigation: back to terminal, email, product link, LinkedIn links
  // ---------------------------------------------------------------------------

  it('renders back to terminal link pointing to /', () => {
    renderWithProviders(<OnePager />);
    const backLink = screen.getByRole('link', { name: /back to terminal/i });
    expect(backLink).toHaveAttribute('href', '/');
  });

  it('renders contact email link', () => {
    renderWithProviders(<OnePager />);
    const emailLink = screen.getByRole('link', { name: /andy@roselabs\.ai/i });
    expect(emailLink).toHaveAttribute('href', 'mailto:andy@roselabs.ai');
  });

  it('renders product link to roselabs.ai', () => {
    renderWithProviders(<OnePager />);
    const productLink = screen.getByRole('link', { name: /full stack product/i });
    expect(productLink).toHaveAttribute('href', 'https://roselabs.ai');
    expect(productLink).toHaveAttribute('target', '_blank');
    expect(productLink).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('renders LinkedIn links for both founders', () => {
    renderWithProviders(<OnePager />);

    const andyLink = screen.getByRole('link', { name: 'Andy' });
    expect(andyLink).toHaveAttribute('href', 'https://linkedin.com/in/andyprevalsky');
    expect(andyLink).toHaveAttribute('target', '_blank');

    const aadityaLink = screen.getByRole('link', { name: 'Aaditya' });
    expect(aadityaLink).toHaveAttribute(
      'href',
      'https://www.linkedin.com/in/aaditya-shidham/',
    );
    expect(aadityaLink).toHaveAttribute('target', '_blank');
  });

  // ---------------------------------------------------------------------------
  // Document title and meta description
  // ---------------------------------------------------------------------------

  it('sets document title to "Rose Labs One Pager"', async () => {
    renderWithProviders(<OnePager />);
    await waitFor(() => {
      expect(document.title).toBe('Rose Labs One Pager');
    });
  });

  it('sets meta description tag', async () => {
    renderWithProviders(<OnePager />);
    await waitFor(() => {
      const meta = document.querySelector('meta[name="description"]');
      expect(meta).not.toBeNull();
      expect(meta!.getAttribute('content')).toContain(
        'Rose Labs investor one pager',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Footer
  // ---------------------------------------------------------------------------

  it('renders copyright with current year', () => {
    renderWithProviders(<OnePager />);
    const year = new Date().getFullYear();
    expect(
      screen.getByText(new RegExp(`© ${year} Rose Labs`)),
    ).toBeInTheDocument();
  });
});
