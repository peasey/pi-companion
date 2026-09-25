import webpush from "web-push";

const keys = webpush.generateVAPIDKeys();
console.log("Add these to your environment (e.g. systemd unit, launchd plist, or .env):");
console.log(`VAPID_SUBJECT=mailto:you@example.com`);
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}`);
console.log(`VAPID_PRIVATE_KEY=${keys.privateKey}`);