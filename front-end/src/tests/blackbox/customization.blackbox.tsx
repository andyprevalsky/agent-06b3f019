import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { screen, waitFor, fireEvent } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { renderWithProviders } from './test-wrapper';
import SystemCustomization from '@/components/customization/SystemCustomization';

describe('SystemCustomization component', () => {
  const defaultProps = {
    data: {
      systemName: 'Rose',
      profilePicture: null,
      customSystemPrompt: 'Test prompt',
    },
    onChange: vi.fn(),
  };

  beforeEach(() => {
    defaultProps.onChange = vi.fn();
  });

  afterEach(() => {
    localStorage.clear();
  });

  // ---------------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------------

  describe('rendering', () => {
    it('renders the assistant name input with the current value', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const nameInput = screen.getByRole('textbox', { name: /assistant name/i });
      expect(nameInput).toBeInTheDocument();
      expect(nameInput).toHaveValue('Rose');
    });

    it('renders the assistant name input with placeholder "Rose"', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const nameInput = screen.getByPlaceholderText('Rose');
      expect(nameInput).toBeInTheDocument();
    });

    it('renders the profile picture section with label and upload button', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      expect(screen.getByText('Profile Picture')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /upload custom image/i })).toBeInTheDocument();
    });

    it('renders the profile picture preview image with default when null', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const img = screen.getByAltText('Profile');
      expect(img).toBeInTheDocument();
      expect(img).toHaveAttribute('src', 'https://roselabs.ai/rose-contact.png');
    });

    it('renders a custom profile picture when one is set', () => {
      const propsWithPicture = {
        ...defaultProps,
        data: { ...defaultProps.data, profilePicture: 'https://example.com/avatar.png' },
      };
      renderWithProviders(<SystemCustomization {...propsWithPicture} />);
      const img = screen.getByAltText('Profile');
      expect(img).toHaveAttribute('src', 'https://example.com/avatar.png');
    });

    it('renders the personality prompt textarea with current value', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const textarea = screen.getByRole('textbox', { name: /personality prompt/i });
      expect(textarea).toBeInTheDocument();
      expect(textarea).toHaveValue('Test prompt');
    });

    it('renders the personality prompt placeholder text', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const textarea = screen.getByPlaceholderText(
        'Describe how you want your assistant to behave...'
      );
      expect(textarea).toBeInTheDocument();
    });

    it('renders character count for the prompt', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      // "Test prompt" is 11 chars; the count is split across elements so use container query
      const container = document.body;
      expect(container.textContent).toContain('11/2000');
    });

    it('renders description text for the assistant name', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      expect(
        screen.getByText('This name will appear in approval messages and SMS notifications')
      ).toBeInTheDocument();
    });

    it('renders description text for the profile picture', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      expect(
        screen.getByText('This image will appear on the contact card saved to your phone')
      ).toBeInTheDocument();
    });

    it('renders description text for the personality prompt', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      expect(
        screen.getByText('This personality will be applied to all your conversations')
      ).toBeInTheDocument();
    });
  });

  // ---------------------------------------------------------------------------
  // User interaction
  // ---------------------------------------------------------------------------

  describe('user interaction', () => {
    it('calls onChange with updated systemName when typing in the name input', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const nameInput = screen.getByRole('textbox', { name: /assistant name/i });

      // Type a character — the component spreads ...data and overrides systemName with e.target.value.
      // Since the component is controlled and we don't re-render with new data,
      // typing appends to the current DOM value ("Rose" + "!" = "Rose!")
      await user.type(nameInput, '!');
      expect(defaultProps.onChange).toHaveBeenCalledWith({
        systemName: 'Rose!',
        profilePicture: null,
        customSystemPrompt: 'Test prompt',
      });
    });

    it('calls onChange with updated customSystemPrompt when typing in the prompt textarea', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const textarea = screen.getByRole('textbox', { name: /personality prompt/i });

      await user.type(textarea, '!');
      expect(defaultProps.onChange).toHaveBeenCalledWith({
        systemName: 'Rose',
        profilePicture: null,
        customSystemPrompt: 'Test prompt!',
      });
    });

    it('triggers the hidden file input when the upload button is clicked', async () => {
      const user = userEvent.setup();
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const uploadButton = screen.getByRole('button', { name: /upload custom image/i });

      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toBeInTheDocument();
      expect(fileInput).toHaveClass('hidden');

      const clickSpy = vi.spyOn(fileInput, 'click');
      await user.click(uploadButton);
      expect(clickSpy).toHaveBeenCalled();
      clickSpy.mockRestore();
    });

    it('shows error for non-image file upload', async () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });

      // Use fireEvent.change to trigger the onChange handler directly
      fireEvent.change(fileInput, { target: { files: [textFile] } });

      await waitFor(() => {
        expect(screen.getByText('Please select an image file')).toBeInTheDocument();
      });
    });

    it('shows error for oversized file upload', async () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      // Create a file larger than 2MB
      const largeContent = new Uint8Array(3 * 1024 * 1024);
      const largeFile = new File([largeContent], 'big.png', { type: 'image/png' });

      fireEvent.change(fileInput, { target: { files: [largeFile] } });

      await waitFor(() => {
        expect(screen.getByText('Image must be smaller than 2MB')).toBeInTheDocument();
      });
    });

    it('does not call onChange for invalid file types', async () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      const textFile = new File(['hello'], 'test.txt', { type: 'text/plain' });
      fireEvent.change(fileInput, { target: { files: [textFile] } });

      await waitFor(() => {
        expect(screen.getByText('Please select an image file')).toBeInTheDocument();
      });
      expect(defaultProps.onChange).not.toHaveBeenCalled();
    });

    it('does not call onChange for oversized files', async () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      const largeContent = new Uint8Array(3 * 1024 * 1024);
      const largeFile = new File([largeContent], 'big.png', { type: 'image/png' });
      fireEvent.change(fileInput, { target: { files: [largeFile] } });

      await waitFor(() => {
        expect(screen.getByText('Image must be smaller than 2MB')).toBeInTheDocument();
      });
      expect(defaultProps.onChange).not.toHaveBeenCalled();
    });

    it('shows "Not authenticated" error when uploading without a session', async () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;

      // Valid image file, but no session in localStorage
      const validFile = new File(['fake-image-data'], 'photo.png', { type: 'image/png' });
      fireEvent.change(fileInput, { target: { files: [validFile] } });

      await waitFor(() => {
        expect(screen.getByText('Not authenticated')).toBeInTheDocument();
      });
    });
  });

  // ---------------------------------------------------------------------------
  // Props behavior
  // ---------------------------------------------------------------------------

  describe('props behavior', () => {
    it('disables inputs when isLoading is true', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} isLoading={true} />);
      const nameInput = screen.getByRole('textbox', { name: /assistant name/i });
      const textarea = screen.getByRole('textbox', { name: /personality prompt/i });
      const uploadButton = screen.getByRole('button', { name: /upload custom image/i });

      expect(nameInput).toBeDisabled();
      expect(textarea).toBeDisabled();
      expect(uploadButton).toBeDisabled();
    });

    it('does not disable inputs when isLoading is false', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} isLoading={false} />);
      const nameInput = screen.getByRole('textbox', { name: /assistant name/i });
      const textarea = screen.getByRole('textbox', { name: /personality prompt/i });
      const uploadButton = screen.getByRole('button', { name: /upload custom image/i });

      expect(nameInput).not.toBeDisabled();
      expect(textarea).not.toBeDisabled();
      expect(uploadButton).not.toBeDisabled();
    });

    it('renders with empty systemName and customSystemPrompt', () => {
      const emptyProps = {
        data: {
          systemName: '',
          profilePicture: null,
          customSystemPrompt: '',
        },
        onChange: vi.fn(),
      };
      renderWithProviders(<SystemCustomization {...emptyProps} />);
      const nameInput = screen.getByRole('textbox', { name: /assistant name/i });
      const textarea = screen.getByRole('textbox', { name: /personality prompt/i });

      expect(nameInput).toHaveValue('');
      expect(textarea).toHaveValue('');
      expect(document.body.textContent).toContain('0/2000');
    });

    it('preserves other data fields when onChange is called from name input', async () => {
      const user = userEvent.setup();
      const propsWithPicture = {
        ...defaultProps,
        data: {
          systemName: 'Rose',
          profilePicture: 'https://example.com/avatar.png',
          customSystemPrompt: 'Be helpful',
        },
      };
      renderWithProviders(<SystemCustomization {...propsWithPicture} />);

      const nameInput = screen.getByRole('textbox', { name: /assistant name/i });
      await user.type(nameInput, '!');

      expect(defaultProps.onChange).toHaveBeenCalledWith({
        systemName: 'Rose!',
        profilePicture: 'https://example.com/avatar.png',
        customSystemPrompt: 'Be helpful',
      });
    });

    it('preserves other data fields when onChange is called from prompt textarea', async () => {
      const user = userEvent.setup();
      const propsWithPicture = {
        ...defaultProps,
        data: {
          systemName: 'Atlas',
          profilePicture: 'https://example.com/avatar.png',
          customSystemPrompt: 'Be helpful',
        },
      };
      renderWithProviders(<SystemCustomization {...propsWithPicture} />);

      const textarea = screen.getByRole('textbox', { name: /personality prompt/i });
      await user.type(textarea, '!');

      expect(defaultProps.onChange).toHaveBeenCalledWith({
        systemName: 'Atlas',
        profilePicture: 'https://example.com/avatar.png',
        customSystemPrompt: 'Be helpful!',
      });
    });

    it('updates character count based on prompt length', () => {
      const longPromptProps = {
        data: {
          systemName: 'Rose',
          profilePicture: null,
          customSystemPrompt: 'A'.repeat(500),
        },
        onChange: vi.fn(),
      };
      renderWithProviders(<SystemCustomization {...longPromptProps} />);
      expect(document.body.textContent).toContain('500/2000');
    });

    it('accepts the file input with image/* mime types', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
      expect(fileInput).toHaveAttribute('accept', 'image/*');
    });

    it('sets maxLength on the name input to 50', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const nameInput = screen.getByRole('textbox', { name: /assistant name/i });
      expect(nameInput).toHaveAttribute('maxlength', '50');
    });

    it('sets maxLength on the prompt textarea to 2000', () => {
      renderWithProviders(<SystemCustomization {...defaultProps} />);
      const textarea = screen.getByRole('textbox', { name: /personality prompt/i });
      expect(textarea).toHaveAttribute('maxlength', '2000');
    });
  });
});
