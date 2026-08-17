import { render, screen } from '@testing-library/react';

import Home from './page';

describe('Home', () => {
  it('renders the getting-started heading', () => {
    render(<Home />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('To get started, edit the');
  });

  it('names the file the reader should edit', () => {
    render(<Home />);

    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('page.tsx');
  });

  it('renders the Next.js logo with accessible alt text', () => {
    render(<Home />);

    expect(screen.getByAltText('Next.js logo')).toBeInTheDocument();
  });

  it('renders the Vercel logomark with accessible alt text', () => {
    render(<Home />);

    expect(screen.getByAltText('Vercel logomark')).toBeInTheDocument();
  });

  it('links to the Vercel templates gallery', () => {
    render(<Home />);

    expect(screen.getByRole('link', { name: 'Templates' })).toHaveAttribute(
      'href',
      expect.stringContaining('vercel.com/templates')
    );
  });

  it('links to the Next.js learning centre', () => {
    render(<Home />);

    expect(screen.getByRole('link', { name: 'Learning' })).toHaveAttribute(
      'href',
      expect.stringContaining('nextjs.org/learn')
    );
  });

  it('links to the Next.js documentation', () => {
    render(<Home />);

    expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute(
      'href',
      expect.stringContaining('nextjs.org/docs')
    );
  });

  describe('external call-to-action links', () => {
    it('opens the deploy link in a new tab', () => {
      render(<Home />);

      expect(screen.getByRole('link', { name: /Deploy Now/ })).toHaveAttribute('target', '_blank');
    });

    // `noopener` denies the opened page access to `window.opener`; without it a
    // target="_blank" link is a reverse-tabnabbing vector.
    it('protects the deploy link against reverse tabnabbing', () => {
      render(<Home />);

      expect(screen.getByRole('link', { name: /Deploy Now/ })).toHaveAttribute('rel', 'noopener noreferrer');
    });

    it('protects the documentation link against reverse tabnabbing', () => {
      render(<Home />);

      expect(screen.getByRole('link', { name: 'Documentation' })).toHaveAttribute('rel', 'noopener noreferrer');
    });
  });
});
