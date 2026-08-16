/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';

import { Button, buttonVariants } from './button';

describe('Button', () => {
  it('renders its children', () => {
    render(<Button>Save changes</Button>);

    expect(screen.getByRole('button', { name: 'Save changes' })).toBeInTheDocument();
  });

  it('marks itself with the button data-slot', () => {
    render(<Button>Save</Button>);

    expect(screen.getByRole('button')).toHaveAttribute('data-slot', 'button');
  });

  it('applies the default variant classes when no variant is given', () => {
    render(<Button>Save</Button>);

    expect(screen.getByRole('button')).toHaveClass('bg-primary');
  });

  it('applies the requested variant classes', () => {
    render(<Button variant="destructive">Delete</Button>);

    expect(screen.getByRole('button')).toHaveClass('text-destructive');
  });

  it('applies the requested size classes', () => {
    render(<Button size="icon">×</Button>);

    expect(screen.getByRole('button')).toHaveClass('size-8');
  });

  it('appends a caller-supplied className', () => {
    render(<Button className="w-full">Save</Button>);

    expect(screen.getByRole('button')).toHaveClass('w-full');
  });

  it('lets a caller className override a conflicting variant utility', () => {
    render(<Button className="bg-transparent">Save</Button>);

    expect(screen.getByRole('button')).not.toHaveClass('bg-primary');
  });

  it('forwards arbitrary props to the underlying element', () => {
    render(<Button aria-label="Close dialog">×</Button>);

    expect(screen.getByRole('button', { name: 'Close dialog' })).toBeInTheDocument();
  });

  it('invokes onClick when activated', async () => {
    const onClick = vi.fn();
    render(<Button onClick={onClick}>Save</Button>);

    await userEvent.click(screen.getByRole('button'));

    expect(onClick).toHaveBeenCalledOnce();
  });

  it('does not invoke onClick while disabled', async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>
    );

    await userEvent.click(screen.getByRole('button'));

    expect(onClick).not.toHaveBeenCalled();
  });

  it('reflects the disabled state on the element', () => {
    render(<Button disabled>Save</Button>);

    expect(screen.getByRole('button')).toBeDisabled();
  });
});

describe('buttonVariants', () => {
  it('emits the default variant and size when called with no arguments', () => {
    const classes = buttonVariants();

    expect(classes).toContain('bg-primary');
  });

  it('emits classes for an explicitly requested variant', () => {
    expect(buttonVariants({ variant: 'link' })).toContain('underline-offset-4');
  });

  it('emits classes for an explicitly requested size', () => {
    expect(buttonVariants({ size: 'icon-lg' })).toContain('size-9');
  });
});
