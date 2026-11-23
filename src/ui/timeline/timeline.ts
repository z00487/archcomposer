/**
 * L5 界面层 · M14 时间轴
 *
 * 依据：《项目概要设计文档》§7.1 的 `ui/timeline/`、§6.3。
 *
 * **时间轴要表达的是「步骤的相对长度」**：各步骤的时长差异是作者编排节奏的
 * 依据，用等宽的块会把这个信息抹掉。因此这里按 `durationMs` 的**比例**分配宽度。
 *
 * **播放时的定位**由 `PlaybackStore.index` 驱动，时间轴本身不掌握播放状态
 * ——这是 L5「不含业务规则」的直接体现。
 */
import type { StoryboardStore, PlaybackStore } from '../../app/stores/stores.ts';
import { el, fill } from '../components/dom.ts';
import { formatDuration, totalDuration } from '../../app/playback/playback.ts';

export interface TimelineDeps {
  storyboard: StoryboardStore;
  playback: PlaybackStore;
  onPlay(): void;
  onPause(): void;
  onStop(): void;
  onSeek(index: number): void;
}

export interface Timeline {
  root: HTMLElement;
  render(): void;
}

export function createTimeline(deps: TimelineDeps): Timeline {
  const track = el('div', { class: 'timeline-track', id: 'timeline-track' });
  const playButton = el('button', { class: 'timeline-button primary', type: 'button', text: '▶ 播放' });
  const pauseButton = el('button', { class: 'timeline-button', type: 'button', text: '❙❙ 暂停' });
  const stopButton = el('button', { class: 'timeline-button', type: 'button', text: '■ 停止' });
  const clock = el('span', { class: 'timeline-clock', id: 'timeline-clock', text: '0:00' });
  const narration = el('div', { class: 'timeline-narration', id: 'playback-narration' });
  const blocked = el('div', { class: 'timeline-blocked', id: 'playback-blocked', hidden: true });

  const controls = el('div', { class: 'timeline-controls' }, [playButton, pauseButton, stopButton, clock]);
  const root = el('section', { class: 'timeline-section' }, [controls, track, narration, blocked]);

  playButton.addEventListener('click', () => deps.onPlay());
  pauseButton.addEventListener('click', () => deps.onPause());
  stopButton.addEventListener('click', () => deps.onStop());

  function render(): void {
    const steps = deps.storyboard.get().storyboard.steps;
    const playback = deps.playback.get();
    const total = totalDuration(steps);
    clock.textContent = `${formatDuration(total)}${steps.length > 0 ? ` · ${steps.length} 步` : ''}`;

    if (steps.length === 0) {
      fill(track, [el('div', { class: 'timeline-empty', text: '分镜为空，时间轴暂无内容' })]);
    } else {
      // 按占比重排宽度；给每块一个最小宽度，避免「1 秒的步骤」被压成一条线点不到
      const blocks = steps.map((step, index) => {
        const ratio = total > 0 ? step.durationMs / total : 1 / steps.length;
        const block = el('button', {
          class: `timeline-block${playback.index === index ? ' current' : ''} ${solveClassOf(step.solve)}`,
          type: 'button',
          title: `${index + 1}. ${step.title}（${formatDuration(step.durationMs)}）`,
        }, [
          el('span', { class: 'timeline-block-index', text: `${index + 1}` }),
          el('span', { class: 'timeline-block-title', text: step.title }),
        ]);
        block.style.flexGrow = String(Math.max(ratio * 100, 6));
        block.addEventListener('click', () => deps.onSeek(index));
        return block;
      });
      fill(track, blocks);
    }

    narration.textContent = playback.narration;
    narration.hidden = !playback.narration;
    blocked.hidden = !playback.blockedReason;
    blocked.textContent = playback.blockedReason ?? '';
  }

  return { root, render };
}

function solveClassOf(state: string): string {
  switch (state) {
    case 'solved':
      return 'is-solved';
    case 'stale':
      return 'is-stale';
    case 'failed':
      return 'is-failed';
    default:
      return 'is-none';
  }
}
