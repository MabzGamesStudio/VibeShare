import { BookOpen, Film, Gamepad2, Image, Music, Package, Podcast, Radio, Smartphone, FileText, Headphones, File } from 'lucide-react';
import type { Format } from '../../../src/shared/taxonomy';

export const FORMAT_ICONS: Record<Format, typeof Film> = {
  video: Film,
  'short-video': Smartphone,
  live: Radio,
  music: Music,
  audio: Headphones,
  podcast: Podcast,
  image: Image,
  article: FileText,
  game: Gamepad2,
  software: Package,
  book: BookOpen,
  file: File,
  other: File,
};

export function FormatIcon({ format, size = 18 }: { format: Format; size?: number }) {
  const Icon = FORMAT_ICONS[format] ?? File;
  return <Icon size={size} />;
}
