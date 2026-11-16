import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import { renderWithProviders } from './test-wrapper';
import ResearchBlog from '@/pages/ResearchBlog';
import { blogPosts, getBlogPostsByCategory, formatDate } from '@/features/blog';

const researchPosts = getBlogPostsByCategory('research');

describe('ResearchBlog page', () => {
  // ── Header branding ──────────────────────────────────────────────
  describe('header', () => {
    it('renders Rose Labs brand name in header', () => {
      renderWithProviders(<ResearchBlog />);
      // "Rose Labs" appears in header and footer — use getAllByText
      const matches = screen.getAllByText('Rose Labs');
      expect(matches.length).toBeGreaterThanOrEqual(1);
    });

    it('renders the Rose Labs logo link pointing to homepage', () => {
      renderWithProviders(<ResearchBlog />);
      // The header logo link wraps "Rose Labs" text and points to "/"
      const allLinks = screen.getAllByRole('link', { name: /rose labs/i });
      const homeLink = allLinks.find((el) => el.getAttribute('href') === '/');
      expect(homeLink).toBeDefined();
    });

    it('renders download link with correct DMG URL', () => {
      renderWithProviders(<ResearchBlog />);
      const downloadLink = screen.getByRole('link', { name: /download/i });
      expect(downloadLink).toHaveAttribute('href', expect.stringContaining('Rose-mac.dmg'));
    });

    it('download link points to Supabase storage', () => {
      renderWithProviders(<ResearchBlog />);
      const downloadLink = screen.getByRole('link', { name: /download/i });
      expect(downloadLink).toHaveAttribute('href', expect.stringContaining('supabase.co/storage'));
    });
  });

  // ── Blog post cards ──────────────────────────────────────────────
  describe('blog post cards', () => {
    it('renders a card for every research-category post', () => {
      renderWithProviders(<ResearchBlog />);
      researchPosts.forEach((post) => {
        expect(screen.getByText(post.title)).toBeInTheDocument();
      });
    });

    it('renders post descriptions', () => {
      renderWithProviders(<ResearchBlog />);
      researchPosts.forEach((post) => {
        expect(screen.getByText(post.description)).toBeInTheDocument();
      });
    });

    it('renders formatted dates for each post', () => {
      renderWithProviders(<ResearchBlog />);
      researchPosts.forEach((post) => {
        const formatted = formatDate(post.date);
        expect(screen.getByText(new RegExp(formatted))).toBeInTheDocument();
      });
    });

    it('renders category label on each card', () => {
      renderWithProviders(<ResearchBlog />);
      // Each card shows post.category ("research") — at least one per card
      const categoryLabels = screen.getAllByText('research');
      // At least one per research post (cards) + sidebar
      expect(categoryLabels.length).toBeGreaterThanOrEqual(researchPosts.length);
    });

    it('each card links to the correct detail page via /research/:slug', () => {
      renderWithProviders(<ResearchBlog />);
      researchPosts.forEach((post) => {
        const heading = screen.getByText(post.title);
        // The card is wrapped in a <Link> so the closest <a> is the card link
        const cardLink = heading.closest('a');
        expect(cardLink).not.toBeNull();
        expect(cardLink).toHaveAttribute('href', `/research/${post.slug}`);
      });
    });

    it('each card wraps content in an <article> element', () => {
      renderWithProviders(<ResearchBlog />);
      const articles = document.querySelectorAll('article');
      expect(articles.length).toBe(researchPosts.length);
    });

    it('does not render non-research posts', () => {
      renderWithProviders(<ResearchBlog />);
      const nonResearch = blogPosts.filter((p) => p.category !== 'research');
      nonResearch.forEach((post) => {
        expect(screen.queryByText(post.title)).not.toBeInTheDocument();
      });
    });
  });

  // ── Sidebar ──────────────────────────────────────────────────────
  describe('sidebar', () => {
    it('renders a sidebar navigation element', () => {
      renderWithProviders(<ResearchBlog />);
      const nav = document.querySelector('aside nav');
      expect(nav).not.toBeNull();
    });

    it('sidebar contains a "research" category link', () => {
      renderWithProviders(<ResearchBlog />);
      const aside = document.querySelector('aside')!;
      const researchLink = within(aside).getByRole('link', { name: /research/i });
      expect(researchLink).toHaveAttribute('href', '/research');
    });
  });

  // ── Footer ───────────────────────────────────────────────────────
  describe('footer', () => {
    it('renders the NaviFooter with copyright notice', () => {
      renderWithProviders(<ResearchBlog />);
      expect(screen.getByText(/© 2026 Rose Labs/i)).toBeInTheDocument();
    });

    it('footer contains company links (Privacy, Terms) and no About page link', () => {
      renderWithProviders(<ResearchBlog />);
      const footer = document.querySelector('footer')!;
      expect(within(footer).queryByRole('link', { name: /^about$/i })).not.toBeInTheDocument();
      expect(within(footer).getByRole('link', { name: /^privacy$/i })).toHaveAttribute(
        'href',
        '/privacy',
      );
      expect(within(footer).getByRole('link', { name: /^terms$/i })).toHaveAttribute(
        'href',
        '/terms',
      );
    });

    it('footer renders Rose Labs branding', () => {
      renderWithProviders(<ResearchBlog />);
      const footer = document.querySelector('footer')!;
      expect(within(footer).getByText('Rose Labs')).toBeInTheDocument();
    });
  });

  // ── Layout structure ─────────────────────────────────────────────
  describe('layout', () => {
    it('renders inside a <main> element', () => {
      renderWithProviders(<ResearchBlog />);
      const main = document.querySelector('main');
      expect(main).not.toBeNull();
    });

    it('renders sidebar and post area in a grid layout', () => {
      renderWithProviders(<ResearchBlog />);
      const aside = document.querySelector('aside');
      expect(aside).not.toBeNull();
      // The aside and posts area are siblings in a grid container
      const gridParent = aside!.parentElement;
      expect(gridParent).not.toBeNull();
      expect(gridParent!.classList.contains('grid')).toBe(true);
    });
  });
});
