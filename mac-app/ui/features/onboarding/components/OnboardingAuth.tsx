import { SignupForm } from './SignupForm';
import { OtpForm } from './OtpForm';
import { useOnboardingAuth } from '../hooks';

interface OnboardingAuthProps {
  onComplete: () => void;
}

const OnboardingAuth = ({ onComplete }: OnboardingAuthProps): JSX.Element => {
  const auth = useOnboardingAuth(onComplete);

  if (auth.step === 'signup') {
    return (
      <SignupForm
        firstName={auth.firstName}
        lastName={auth.lastName}
        phone={auth.phone}
        loading={auth.loading}
        error={auth.error}
        isFormValid={auth.isFormValid}
        onFirstNameChange={auth.setFirstName}
        onLastNameChange={auth.setLastName}
        onPhoneChange={auth.setPhone}
        onSubmit={auth.handleSignupSubmit}
      />
    );
  }

  return (
    <OtpForm
      phone={auth.phone}
      otp={auth.otp}
      smsAuthorized={auth.smsAuthorized}
      loading={auth.loading}
      error={auth.error}
      resendCountdown={auth.resendCountdown}
      onOtpChange={auth.setOtp}
      onSmsAuthorizedChange={auth.setSmsAuthorized}
      onSubmit={auth.handleOtpSubmit}
      onResend={auth.handleResendOTP}
      onBackToSignup={auth.handleBackToSignup}
    />
  );
};

export default OnboardingAuth;
