import { describe, it, expect } from 'vitest';
import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import BlogPostCard from '@/components/blog/BlogPostCard';
import BlogHeader from '@/components/blog/BlogHeader';
import BlogContent from '@/components/blog/BlogContent';
import BlogTableOfContents from '@/components/blog/BlogTableOfContents';
import BlogSidebar from '@/components/blog/BlogSidebar';
import BlogBreadcrumb from '@/components/blog/BlogBreadcrumb';
import {
  blogPosts,
  getBlogPost,
  getBlogPostsByCategory,
  formatDate,
  type BlogPost,
  type BlogSection,
} from '@/data/blogPosts';

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const realPost = blogPosts[0]; // "task-decomposer" post

const minimalPost: BlogPost = {
  slug: 'test-slug',
  title: 'Test Blog Post Title',
  description: 'A short description for the test post.',
  category: 'product',
  date: '2025-12-01',
  author: 'Test Author',
  intro: 'This is the intro paragraph for the test post.',
  sections: [
    { id: 'section-one', title: 'First Section', content: 'Content of the first section.' },
    { id: 'section-two', title: 'Second Section', content: 'Content of the second section.' },
  ],
};

const postWithImages: BlogPost = {
  slug: 'images-post',
  title: 'Post With Images',
  description: 'A post that includes images.',
  category: 'company',
  date: '2026-01-15',
  author: 'Image Author',
  intro: 'Intro with images below.',
  sections: [{ id: 'img-section', title: 'Image Section', content: 'Some image content.' }],
  images: [
    { src: '/blog/chart.png', alt: 'Performance chart', caption: 'Figure 1: Performance' },
    { src: '/blog/diagram.png', alt: 'Architecture diagram' },
  ],
};

const postWithMultiParagraphIntro: BlogPost = {
  slug: 'multi-intro',
  title: 'Multi Paragraph Intro Post',
  description: 'Has two intro paragraphs.',
  category: 'research',
  date: '2026-02-10',
  author: 'Multi Author',
  intro: 'First intro paragraph.\n\nSecond intro paragraph.',
  sections: [{ id: 'sec', title: 'Only Section', content: 'Paragraph one.\n\nParagraph two.' }],
};

// ---------------------------------------------------------------------------
// BlogPostCard
// ---------------------------------------------------------------------------

describe('BlogPostCard', () => {
  it('renders the post title', () => {
    renderWithProviders(<BlogPostCard post={realPost} />);
    expect(screen.getByText(realPost.title)).toBeInTheDocument();
  });

  it('renders the post description', () => {
    renderWithProviders(<BlogPostCard post={minimalPost} />);
    expect(screen.getByText(minimalPost.description)).toBeInTheDocument();
  });

  it('renders the formatted date', () => {
    renderWithProviders(<BlogPostCard post={realPost} />);
    const formatted = formatDate(realPost.date);
    expect(screen.getByText(new RegExp(formatted))).toBeInTheDocument();
  });

  it('renders the category text', () => {
    renderWithProviders(<BlogPostCard post={minimalPost} />);
    expect(screen.getByText(minimalPost.category)).toBeInTheDocument();
  });

  it('links to /research/{slug}', () => {
    renderWithProviders(<BlogPostCard post={realPost} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', `/research/${realPost.slug}`);
  });

  it('renders an article element', () => {
    renderWithProviders(<BlogPostCard post={minimalPost} />);
    expect(screen.getByRole('article')).toBeInTheDocument();
  });

  it('renders dot separator between category and date', () => {
    renderWithProviders(<BlogPostCard post={minimalPost} />);
    expect(screen.getByText('·')).toBeInTheDocument();
  });

  it('renders correct link for different slugs', () => {
    renderWithProviders(<BlogPostCard post={minimalPost} />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/research/test-slug');
  });
});

// ---------------------------------------------------------------------------
// BlogHeader
// ---------------------------------------------------------------------------

describe('BlogHeader', () => {
  it('renders the post title as a heading', () => {
    renderWithProviders(<BlogHeader post={realPost} />);
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent(realPost.title);
  });

  it('renders the formatted date', () => {
    renderWithProviders(<BlogHeader post={realPost} />);
    const formatted = formatDate(realPost.date);
    expect(screen.getByText(new RegExp(formatted))).toBeInTheDocument();
  });

  it('renders the author name', () => {
    renderWithProviders(<BlogHeader post={realPost} />);
    expect(screen.getByText(new RegExp(realPost.author))).toBeInTheDocument();
  });

  it('renders date and author together with "by" separator', () => {
    renderWithProviders(<BlogHeader post={minimalPost} />);
    const formatted = formatDate(minimalPost.date);
    expect(
      screen.getByText(new RegExp(`${formatted}\\s+by\\s+${minimalPost.author}`))
    ).toBeInTheDocument();
  });

  it('renders within a header element', () => {
    renderWithProviders(<BlogHeader post={minimalPost} />);
    expect(screen.getByRole('banner')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// BlogContent
// ---------------------------------------------------------------------------

describe('BlogContent', () => {
  it('renders the intro text', () => {
    renderWithProviders(<BlogContent post={minimalPost} />);
    expect(screen.getByText(minimalPost.intro)).toBeInTheDocument();
  });

  it('renders section headings as h2', () => {
    renderWithProviders(<BlogContent post={minimalPost} />);
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(minimalPost.sections.length);
    expect(headings[0]).toHaveTextContent('First Section');
    expect(headings[1]).toHaveTextContent('Second Section');
  });

  it('renders section content', () => {
    renderWithProviders(<BlogContent post={minimalPost} />);
    expect(screen.getByText('Content of the first section.')).toBeInTheDocument();
    expect(screen.getByText('Content of the second section.')).toBeInTheDocument();
  });

  it('renders all sections from a real post', () => {
    renderWithProviders(<BlogContent post={realPost} />);
    const headings = screen.getAllByRole('heading', { level: 2 });
    expect(headings).toHaveLength(realPost.sections.length);
    realPost.sections.forEach((section, i) => {
      expect(headings[i]).toHaveTextContent(section.title);
    });
  });

  it('sets section id attributes for anchor navigation', () => {
    const { container } = renderWithProviders(<BlogContent post={minimalPost} />);
    minimalPost.sections.forEach((section) => {
      expect(container.querySelector(`#${section.id}`)).not.toBeNull();
    });
  });

  it('renders images with alt text when post has images', () => {
    renderWithProviders(<BlogContent post={postWithImages} />);
    const images = screen.getAllByRole('img');
    expect(images).toHaveLength(2);
    expect(images[0]).toHaveAttribute('alt', 'Performance chart');
    expect(images[1]).toHaveAttribute('alt', 'Architecture diagram');
  });

  it('renders image captions when provided', () => {
    renderWithProviders(<BlogContent post={postWithImages} />);
    expect(screen.getByText('Figure 1: Performance')).toBeInTheDocument();
  });

  it('renders image src attributes correctly', () => {
    renderWithProviders(<BlogContent post={postWithImages} />);
    const images = screen.getAllByRole('img');
    expect(images[0]).toHaveAttribute('src', '/blog/chart.png');
    expect(images[1]).toHaveAttribute('src', '/blog/diagram.png');
  });

  it('does not render figure elements when post has no images', () => {
    const { container } = renderWithProviders(<BlogContent post={minimalPost} />);
    expect(container.querySelectorAll('figure')).toHaveLength(0);
  });

  it('splits multi-paragraph intro into separate p elements', () => {
    const { container } = renderWithProviders(<BlogContent post={postWithMultiParagraphIntro} />);
    // The intro "First intro paragraph.\n\nSecond intro paragraph." splits into 2 <p> tags
    // inside the intro div (first child div of the outer container)
    const introDiv = container.querySelector('.text-lg.text-slate-600');
    const paragraphs = introDiv?.querySelectorAll('p');
    expect(paragraphs?.length).toBe(2);
  });

  it('splits multi-paragraph section content into separate p elements', () => {
    const { container } = renderWithProviders(<BlogContent post={postWithMultiParagraphIntro} />);
    // Section content "Paragraph one.\n\nParagraph two." splits into 2 <p> tags
    const sectionDiv = container.querySelector(`#sec`)?.querySelector('.space-y-4');
    const paragraphs = sectionDiv?.querySelectorAll('p');
    expect(paragraphs?.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// BlogTableOfContents
// ---------------------------------------------------------------------------

describe('BlogTableOfContents', () => {
  const sections: BlogSection[] = [
    { id: 'intro', title: 'Introduction', content: '' },
    { id: 'methods', title: 'Methods', content: '' },
    { id: 'results', title: 'Results', content: '' },
  ];

  it('renders "Table of Contents" label', () => {
    renderWithProviders(<BlogTableOfContents sections={sections} />);
    expect(screen.getByText('Table of Contents')).toBeInTheDocument();
  });

  it('renders all section titles as buttons', () => {
    renderWithProviders(<BlogTableOfContents sections={sections} />);
    sections.forEach((section) => {
      expect(screen.getByText(section.title)).toBeInTheDocument();
    });
  });

  it('starts expanded by default', () => {
    renderWithProviders(<BlogTableOfContents sections={sections} />);
    // All section titles should be visible since isOpen defaults to true
    expect(screen.getByText('Introduction')).toBeVisible();
    expect(screen.getByText('Methods')).toBeVisible();
    expect(screen.getByText('Results')).toBeVisible();
  });

  it('collapses when the toggle button is clicked', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BlogTableOfContents sections={sections} />);

    // Click the toggle button (the one with "Table of Contents" text)
    await user.click(screen.getByText('Table of Contents'));

    // Section titles should no longer be visible
    expect(screen.queryByText('Introduction')).not.toBeInTheDocument();
    expect(screen.queryByText('Methods')).not.toBeInTheDocument();
    expect(screen.queryByText('Results')).not.toBeInTheDocument();
  });

  it('re-expands when toggled twice', async () => {
    const user = userEvent.setup();
    renderWithProviders(<BlogTableOfContents sections={sections} />);

    // Collapse
    await user.click(screen.getByText('Table of Contents'));
    expect(screen.queryByText('Introduction')).not.toBeInTheDocument();

    // Expand again
    await user.click(screen.getByText('Table of Contents'));
    expect(screen.getByText('Introduction')).toBeVisible();
  });

  it('renders section titles from real blog post', () => {
    renderWithProviders(<BlogTableOfContents sections={realPost.sections} />);
    realPost.sections.forEach((section) => {
      expect(screen.getByText(section.title)).toBeInTheDocument();
    });
  });

  it('renders correct number of section buttons', () => {
    renderWithProviders(<BlogTableOfContents sections={sections} />);
    // 1 toggle button + 3 section buttons = 4 total buttons
    const buttons = screen.getAllByRole('button');
    expect(buttons).toHaveLength(4);
  });
});

// ---------------------------------------------------------------------------
// BlogSidebar
// ---------------------------------------------------------------------------

describe('BlogSidebar', () => {
  it('renders "research" category link', () => {
    renderWithProviders(<BlogSidebar />);
    expect(screen.getByText('research')).toBeInTheDocument();
  });

  it('links to /research', () => {
    renderWithProviders(<BlogSidebar />);
    const link = screen.getByRole('link');
    expect(link).toHaveAttribute('href', '/research');
  });

  it('renders within a nav element', () => {
    renderWithProviders(<BlogSidebar />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// BlogBreadcrumb
// ---------------------------------------------------------------------------

describe('BlogBreadcrumb', () => {
  it('renders "Blog" link', () => {
    renderWithProviders(<BlogBreadcrumb category="research" />);
    expect(screen.getByText('Blog')).toBeInTheDocument();
  });

  it('renders the category name', () => {
    renderWithProviders(<BlogBreadcrumb category="research" />);
    expect(screen.getByText('research')).toBeInTheDocument();
  });

  it('renders "/" separator between breadcrumb segments', () => {
    renderWithProviders(<BlogBreadcrumb category="research" />);
    expect(screen.getByText('/')).toBeInTheDocument();
  });

  it('links Blog to /research', () => {
    renderWithProviders(<BlogBreadcrumb category="research" />);
    const links = screen.getAllByRole('link');
    expect(links[0]).toHaveAttribute('href', '/research');
  });

  it('links category to /research', () => {
    renderWithProviders(<BlogBreadcrumb category="research" />);
    const links = screen.getAllByRole('link');
    expect(links[1]).toHaveAttribute('href', '/research');
  });

  it('renders within a nav element', () => {
    renderWithProviders(<BlogBreadcrumb category="research" />);
    expect(screen.getByRole('navigation')).toBeInTheDocument();
  });

  it('renders product category correctly', () => {
    renderWithProviders(<BlogBreadcrumb category="product" />);
    expect(screen.getByText('product')).toBeInTheDocument();
  });

  it('renders company category correctly', () => {
    renderWithProviders(<BlogBreadcrumb category="company" />);
    expect(screen.getByText('company')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// Data layer: blogPosts, getBlogPost, getBlogPostsByCategory, formatDate
// ---------------------------------------------------------------------------

describe('Blog data layer', () => {
  describe('blogPosts array', () => {
    it('contains at least one blog post', () => {
      expect(blogPosts.length).toBeGreaterThanOrEqual(1);
    });

    it('every post has required fields', () => {
      blogPosts.forEach((post) => {
        expect(post.slug).toBeTruthy();
        expect(post.title).toBeTruthy();
        expect(post.description).toBeTruthy();
        expect(post.category).toBeTruthy();
        expect(post.date).toBeTruthy();
        expect(post.author).toBeTruthy();
        expect(post.intro).toBeTruthy();
        expect(post.sections.length).toBeGreaterThanOrEqual(1);
      });
    });

    it('every post has a valid category', () => {
      const validCategories = ['research', 'product', 'company'];
      blogPosts.forEach((post) => {
        expect(validCategories).toContain(post.category);
      });
    });

    it('every section has an id and title', () => {
      blogPosts.forEach((post) => {
        post.sections.forEach((section) => {
          expect(section.id).toBeTruthy();
          expect(section.title).toBeTruthy();
        });
      });
    });

    it('slugs are unique', () => {
      const slugs = blogPosts.map((p) => p.slug);
      expect(new Set(slugs).size).toBe(slugs.length);
    });

    it('dates are valid ISO date strings', () => {
      blogPosts.forEach((post) => {
        const parsed = new Date(post.date);
        expect(parsed.toString()).not.toBe('Invalid Date');
      });
    });
  });

  describe('getBlogPost', () => {
    it('returns the post for a valid slug', () => {
      const post = getBlogPost('task-decomposer');
      expect(post).toBeDefined();
      expect(post!.slug).toBe('task-decomposer');
    });

    it('returns undefined for an invalid slug', () => {
      expect(getBlogPost('nonexistent-slug')).toBeUndefined();
    });
  });

  describe('getBlogPostsByCategory', () => {
    it('returns all posts when category is "all"', () => {
      const all = getBlogPostsByCategory('all');
      expect(all).toHaveLength(blogPosts.length);
    });

    it('returns only research posts for "research" category', () => {
      const research = getBlogPostsByCategory('research');
      research.forEach((post) => {
        expect(post.category).toBe('research');
      });
    });

    it('returns empty array for a category with no posts', () => {
      // "product" and "company" currently have no posts in the real data
      const result = getBlogPostsByCategory('product');
      expect(result).toHaveLength(0);
    });
  });

  describe('formatDate', () => {
    it('formats a date string to localized format with month, day, year', () => {
      const result = formatDate('2026-03-22');
      // toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      // Note: Date parsing of YYYY-MM-DD is UTC, locale display may shift day by timezone
      expect(result).toMatch(/Mar/);
      expect(result).toMatch(/2026/);
      // Should contain a numeric day
      expect(result).toMatch(/\d{1,2}/);
    });

    it('returns a string matching the expected locale pattern', () => {
      // Directly compare against the same toLocaleDateString call
      const dateStr = '2025-06-15';
      const result = formatDate(dateStr);
      const expected = new Date(dateStr).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      expect(result).toBe(expected);
    });

    it('produces consistent results for the real post date', () => {
      const result = formatDate(realPost.date);
      const expected = new Date(realPost.date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
      expect(result).toBe(expected);
    });
  });
});
