import { createNavigation } from 'next-intl/navigation';
import { routing } from './routing';

// Ссылки и переходы с учётом языка. В коде экранов используются они, а не next/link и next/navigation:
// адрес пишется без языка, язык подставляется сам.
export const { Link, redirect, usePathname, useRouter, getPathname } = createNavigation(routing);
