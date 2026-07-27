/* Barrel for the vendored FormFlow design system.
   Import from '@/ds' rather than reaching into subdirectories. */

// core
export { Icon } from './components/core/Icon.jsx';
export { Button } from './components/core/Button.jsx';
export { IconButton } from './components/core/IconButton.jsx';
export { Badge } from './components/core/Badge.jsx';
export { BoxedFrame } from './components/core/BoxedFrame.jsx';
export { Card } from './components/core/Card.jsx';
export { Chip } from './components/core/Chip.jsx';
export { WindowChrome } from './components/core/WindowChrome.jsx';

// forms
export { Field } from './components/forms/Field.jsx';
export { Input } from './components/forms/Input.jsx';
export { Select } from './components/forms/Select.jsx';
export { Switch } from './components/forms/Switch.jsx';
export { Checkbox } from './components/forms/Checkbox.jsx';
export { RangeSlider } from './components/forms/RangeSlider.jsx';
export { FormCard } from './components/forms/FormCard.jsx';

// marketing
export { SectionHeading } from './components/marketing/SectionHeading.jsx';
export { ThemeToggle } from './components/marketing/ThemeToggle.jsx';
export { FeatureCard } from './components/marketing/FeatureCard.jsx';
export { TemplateCard } from './components/marketing/TemplateCard.jsx';
export { PricingCard } from './components/marketing/PricingCard.jsx';
export { StepCard } from './components/marketing/StepCard.jsx';
export { Marquee } from './components/marketing/Marquee.jsx';

// effects
export { Backdrop } from './components/effects/Backdrop.jsx';

/* Deliberately not re-exported — these render FormFlow's own brand and are
   superseded by heddle equivalents in components/:
     components/marketing/Wordmark.jsx   -> components/Wordmark.tsx
     components/marketing/NavBar.jsx     -> components/Nav.tsx
     components/marketing/SiteFooter.jsx -> components/Footer.tsx
   They stay on disk so upstream updates still merge cleanly. */
