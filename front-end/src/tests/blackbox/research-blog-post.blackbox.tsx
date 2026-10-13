import { describe, it, expect } from 'vitest';
import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Routes, Route } from 'react-router-dom';
import { renderWithProviders } from './test-wrapper';
import ResearchBlogPost from '@/pages/ResearchBlogPost';
import { blogPosts, formatDate } from '@/features/blog';

const validPost = blogPosts[0]; // task-decomposer

function renderBlogPost(slug: string) {
  return renderWithProviders(
    <Routes>
      <Route path="/research/:slug" element={<ResearchBlogPost />} />
    </Routes>,
    { route: `/research/${slug}` },
  );
}

describe('ResearchBlogPost page', () => {
  describe('valid slug — post rendering', () => {
    it('renders the post title in the header', () => {
      renderBlogPost(validPost.slug);
      const heading = screen.getByRole('heading', { level: 1 });
      expect(heading).toHaveTextContent(validPost.title);
    });

    it('renders date and author metadata', () => {
      renderBlogPost(validPost.slug);
      const formatted = formatDate(validPost.date);
      expect(screen.getByText(new RegExp(`${formatted}.*${validPost.author}`))).toBeInTheDocument();
    });

    it('renders the intro text', () => {
      renderBlogPost(validPost.slug);
      // Check a distinctive phrase from the intro
      expect(
        screen.getByText(/personal assistants that take action in the world/i),
      ).toBeInTheDocument();
    });

    it('renders all section headings as h2 elements', () => {
      renderBlogPost(validPost.slug);
      for (const section of validPost.sections) {
        const heading = screen.getByRole('heading', { level: 2, name: section.title });
        expect(heading).toBeInTheDocument();
      }
    });

    it('renders section content within each section', () => {
      renderBlogPost(validPost.slug);
      // Spot-check content from specific sections
      expect(screen.getByText(/Superintelligence, as we will know it/i)).toBeInTheDocument();
      expect(
        screen.getByText(/Training a model that can decompose real-world problems/i),
      ).toBeInTheDocument();
    });
  });

  describe('valid slug — table of contents', () => {
    it('renders the Table of Contents toggle button', () => {
      renderBlogPost(validPost.slug);
      expect(screen.getByRole('button', { name: /table of contents/i })).toBeInTheDocument();
    });

    it('renders all section titles as ToC entries (open by default)', () => {
      renderBlogPost(validPost.slug);
      for (const section of validPost.sections) {
        // Section title appears in both ToC (button) and content (h2)
        const matches = screen.getAllByText(section.title);
        expect(matches.length).toBeGreaterThanOrEqual(2);
      }
    });

    it('collapses the ToC when toggle button is clicked', async () => {
      const user = userEvent.setup();
      renderBlogPost(validPost.slug);

      const toggleButton = screen.getByRole('button', { name: /table of contents/i });

      // Before collapse: first section title appears in ToC + content
      const firstSectionTitle = validPost.sections[0].title;
      expect(screen.getAllByText(firstSectionTitle).length).toBeGreaterThanOrEqual(2);

      await user.click(toggleButton);

      // After collapse: section title only appears once (in the content h2), ToC buttons are hidden
      const afterMatches = screen.getAllByText(firstSectionTitle);
      expect(afterMatches.length).toBe(1);
    });

    it('re-expands the ToC on second click', async () => {
      const user = userEvent.setup();
      renderBlogPost(validPost.slug);

      const toggleButton = screen.getByRole('button', { name: /table of contents/i });

      // Collapse
      await user.click(toggleButton);
      // Re-expand
      await user.click(toggleButton);

      const firstSectionTitle = validPost.sections[0].title;
      expect(screen.getAllByText(firstSectionTitle).length).toBeGreaterThanOrEqual(2);
    });
  });

  describe('valid slug — navigation header', () => {
    it('renders Rose Labs branding with link to home', () => {
      renderBlogPost(validPost.slug);
      // Rose Labs appears in header and footer
      const roseLabsLinks = screen.getAllByText('Rose Labs');
      expect(roseLabsLinks.length).toBeGreaterThanOrEqual(1);

      // The header branding link should point to home
      const homeLinks = screen.getAllByRole('link', { name: /rose labs/i });
      const headerLink = homeLinks.find((link) => link.getAttribute('href') === '/');
      expect(headerLink).toBeDefined();
    });

    it('renders the download link pointing to the DMG', () => {
      renderBlogPost(validPost.slug);
      const downloadLink = screen.getByRole('link', { name: /download/i });
      expect(downloadLink).toHaveAttribute('href', expect.stringContaining('Rose-mac.dmg'));
    });
  });

  describe('valid slug — breadcrumb navigation', () => {
    it('renders breadcrumb with Blog link to /research', () => {
      renderBlogPost(validPost.slug);
      const breadcrumbNav =
        document.querySelector<HTMLElement>('nav[aria-label]') ?? screen.getByRole('navigation');
      const blogLink = within(breadcrumbNav).getByText('Blog');
      expect(blogLink.closest<HTMLElement>('a')).toHaveAttribute('href', '/research');
    });

    it('renders breadcrumb category matching the post category', () => {
      renderBlogPost(validPost.slug);
      const breadcrumbNav =
        document.querySelector<HTMLElement>('nav[aria-label]') ?? screen.getByRole('navigation');
      expect(within(breadcrumbNav).getByText(validPost.category)).toBeInTheDocument();
    });

    it('renders breadcrumb category link pointing to /research', () => {
      renderBlogPost(validPost.slug);
      const breadcrumbNav =
        document.querySelector<HTMLElement>('nav[aria-label]') ?? screen.getByRole('navigation');
      const categoryLink = within(breadcrumbNav).getByText(validPost.category);
      expect(categoryLink.closest<HTMLElement>('a')).toHaveAttribute('href', '/research');
    });
  });

  describe('valid slug — footer', () => {
    it('renders the footer with copyright', () => {
      renderBlogPost(validPost.slug);
      expect(screen.getByText(/© 2026 Rose Labs/)).toBeInTheDocument();
    });
  });

  describe('invalid slug — 404', () => {
    it('renders "Post not found" heading', () => {
      renderBlogPost('non-existent-post');
      expect(screen.getByRole('heading', { name: /post not found/i })).toBeInTheDocument();
    });

    it('renders a "Back to all posts" link pointing to /research', () => {
      renderBlogPost('non-existent-post');
      const backLink = screen.getByRole('link', { name: /back to all posts/i });
      expect(backLink).toHaveAttribute('href', '/research');
    });

    it('does not render any blog content elements', () => {
      renderBlogPost('non-existent-post');
      expect(screen.queryByText(/table of contents/i)).not.toBeInTheDocument();
      expect(screen.queryByRole('heading', { level: 2 })).not.toBeInTheDocument();
    });

    it('does not render the header branding or download link', () => {
      renderBlogPost('non-existent-post');
      expect(screen.queryByText('Rose Labs')).not.toBeInTheDocument();
      expect(screen.queryByRole('link', { name: /download/i })).not.toBeInTheDocument();
    });
  });
});
