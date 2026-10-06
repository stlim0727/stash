import { Redirect } from 'expo-router';

// The outstanding system-browser promise handles/validates the callback.
// Navigation alone never accepts a CAPTCHA token or creates an auth session.
export default function CaptchaCallback() { return <Redirect href="/" />; }
