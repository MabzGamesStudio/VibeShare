import {
  BookOpen,
  Compass,
  Film,
  FlaskConical,
  Flame,
  Gamepad2,
  GraduationCap,
  Heart,
  Home,
  Image,
  Music,
  Newspaper,
  Podcast,
  Radio,
  Search,
  Smartphone,
  Sparkles,
  Star,
  Tv,
  Users,
} from 'lucide-react';
import type { PageIcon } from '../../../../src/shared/clientapi';

export const PAGE_ICON_COMPONENTS: Record<PageIcon, typeof Home> = {
  home: Home,
  film: Film,
  smartphone: Smartphone,
  image: Image,
  music: Music,
  podcast: Podcast,
  gamepad: Gamepad2,
  book: BookOpen,
  newspaper: Newspaper,
  flask: FlaskConical,
  graduation: GraduationCap,
  heart: Heart,
  star: Star,
  flame: Flame,
  compass: Compass,
  search: Search,
  users: Users,
  sparkles: Sparkles,
  tv: Tv,
  radio: Radio,
};

export function PageIconView({ icon, size = 19 }: { icon: PageIcon; size?: number }) {
  const Icon = PAGE_ICON_COMPONENTS[icon] ?? Sparkles;
  return <Icon size={size} />;
}
