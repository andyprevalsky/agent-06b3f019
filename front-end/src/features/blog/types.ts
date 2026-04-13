export type BlogCategory = 'research' | 'product' | 'company';

export interface BlogSection {
  id: string;
  title: string;
  content: string;
}

export interface BlogImage {
  src: string;
  alt: string;
  caption?: string;
}

export interface BlogPost {
  slug: string;
  title: string;
  description: string;
  category: BlogCategory;
  date: string;
  author: string;
  intro: string;
  sections: BlogSection[];
  images?: BlogImage[];
}
