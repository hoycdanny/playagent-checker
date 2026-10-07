import { z } from 'zod';

/**
 * 執行平台(Worker 種類)。和既有 backend 的對應:
 *   android → backend 'emulator'(EC2 C8i + KVM + Android Emulator;取代舊 Redroid 路徑)
 *   ios     → backend 'ios-simulator'(EC2 Mac + Xcode Simulator)
 *   windows → backend 'windows'(EC2 G6 + Windows + NVIDIA)
 *   linux   → backend 'linux'(EC2 G6 + Ubuntu + NVIDIA + Xorg)
 * Device Farm 真機維持原本的 Fargate runner,不在這個套件裡。
 */
export const PlatformSchema = z.enum(['android', 'ios', 'windows', 'linux']);
export type Platform = z.infer<typeof PlatformSchema>;

export const GameTypeSchema = z.enum(['slot', 'casino', 'rpg', 'action', 'puzzle', 'casual', 'strategy', 'racing', 'survivor', 'other']);
export type GameType = z.infer<typeof GameTypeSchema>;
