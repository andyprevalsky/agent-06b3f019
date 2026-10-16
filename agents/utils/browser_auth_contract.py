"""Existing browser authentication contract shared by its decision consumers."""

OTP_DELIVERY_CONTRACT = 'OTP codes from email or SMS are automatically injected as user messages into your context as soon as they become available. If no OTP code is received after 60 seconds since requested, request a resend of the OTP code. If after another 60 seconds no OTP code is received, consider that authentication route exhausted and unusable.'
