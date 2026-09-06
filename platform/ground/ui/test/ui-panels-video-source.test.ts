/* VideoPanel: which element a configured URL turns into, and what the overlay
 * shows for each connection / tracking state. Rendered with react-dom/server:
 * no canvas, no WHEP, just the markup the operator would see. */
import { describe, expect, it } from 'vitest';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { TrackingStatus } from '@/contract';
import { TRACK_CHIP, VideoPanel, targetCaption, videoSourceKind, whepEndpoint } from '@/panels/VideoPanel';

describe('videoSourceKind', () => {
  it('falls back to the synthetic scene for an empty or unknown URL', () => {
    expect(videoSourceKind(undefined)).toBe('mock');
    expect(videoSourceKind('')).toBe('mock');
    expect(videoSourceKind('   ')).toBe('mock');
    expect(videoSourceKind('rtsps://cam/stream')).toBe('mock');
    expect(videoSourceKind('not a url')).toBe('mock');
  });

  it('renders MJPEG in an <img> regardless of scheme', () => {
    expect(videoSourceKind('http://hub:8080/drones/eis-1/mjpeg')).toBe('mjpeg');
    expect(videoSourceKind('rtsp://cam/MJPEG')).toBe('mjpeg');
  });

  it('plays http(s), webrtc and whep through WHEP and flags rtsp', () => {
    expect(videoSourceKind('http://mediamtx:8889/cam/whep')).toBe('live');
    expect(videoSourceKind('HTTPS://mediamtx:8889/cam/whep')).toBe('live');
    expect(videoSourceKind('webrtc://mediamtx:8889/cam/whep')).toBe('live');
    expect(videoSourceKind('whep://mediamtx:8889/cam/whep')).toBe('live');
    expect(videoSourceKind('rtsp://192.168.1.42:8554/cam')).toBe('rtsp');
  });
});

describe('whepEndpoint', () => {
  it('spells webrtc:// and whep:// as https:// and leaves http(s) alone', () => {
    expect(whepEndpoint('webrtc://host/cam/whep')).toBe('https://host/cam/whep');
    expect(whepEndpoint('WHEP://host/cam/whep')).toBe('https://host/cam/whep');
    expect(whepEndpoint('http://host:8889/cam/whep')).toBe('http://host:8889/cam/whep');
  });
});

describe('targetCaption and chips', () => {
  it('captions the locked target and numbers the rest, confidence in percent', () => {
    expect(targetCaption({ id: 3, confidence: 0.874, isLocked: true })).toBe('LOCKED · 87%');
    expect(targetCaption({ id: 3, confidence: 0.615, isLocked: false })).toBe('PERSON 3 · 62%');
  });

  it('has a chip for every tracking state and no frame when idle', () => {
    expect(Object.keys(TRACK_CHIP).sort()).toEqual(['idle', 'locked', 'lost', 'searching']);
    expect(TRACK_CHIP.idle.border).toBe('transparent');
    expect(TRACK_CHIP.locked.label).toBe('Tracking · Locked');
  });
});

describe('VideoPanel rendering', () => {
  const tracking: TrackingStatus = {
    type: 'tracking', ts: 0, vehicleId: 'eis-1', state: 'locked',
    targets: [
      { id: 1, bbox: [0.4, 0.3, 0.1, 0.4], confidence: 0.87, isLocked: true },
      { id: 2, bbox: [0.7, 0.35, 0.08, 0.3], confidence: 0.62, isLocked: false },
    ],
    lockedTargetId: 1, standoffDistance: 5, estimatedDistance: 4.2, maxSpeed: 3,
  };
  const render = (over: Partial<React.ComponentProps<typeof VideoPanel>>): string =>
    renderToStaticMarkup(
      React.createElement(VideoPanel, {
        tracking: null, connState: 'disconnected', standoff: 5, onSelectTarget: () => {}, ...over,
      }),
    );

  it('shows the no-signal / connecting placeholder over the mock scene until connected', () => {
    expect(render({})).toContain('NO VIDEO SIGNAL');
    expect(render({ connState: 'connecting' })).toContain('CONNECTING…');
    expect(render({ connState: 'connected' })).not.toContain('NO VIDEO SIGNAL');
    expect(render({})).toContain('<canvas');
  });

  it('draws clickable boxes, the range HUD and the state chip once connected and locked', () => {
    const html = render({ connState: 'connected', tracking });
    expect(html).toContain('title="Select target #1"');
    expect(html).toContain('title="Select target #2"');
    expect(html).toContain('LOCKED · 87%');
    expect(html).toContain('PERSON 2 · 62%');
    expect(html).toContain('DIST');
    expect(html).toContain('4.2');
    expect(html).toContain('STANDOFF');
    expect(html).toContain('5.0');
    expect(html).toContain('Tracking · Locked');
  });

  it('hides the range HUD when the tracker has no distance estimate', () => {
    const html = render({ connState: 'connected', tracking: { ...tracking, estimatedDistance: null } });
    expect(html).not.toContain('STANDOFF');
    expect(html).toContain('Tracking · Locked');
  });

  it('never renders the overlay while disconnected, even with stale tracking', () => {
    const html = render({ tracking });
    expect(html).not.toContain('Select target');
    expect(html).not.toContain('Tracking · Locked');
  });

  it('picks the element by source: <img> for MJPEG, <video> for WHEP, a note for RTSP', () => {
    const mjpeg = render({ videoUrl: 'http://hub/drones/eis-1/mjpeg' });
    expect(mjpeg).toContain('<img src="http://hub/drones/eis-1/mjpeg"');
    expect(mjpeg).not.toContain('<canvas');
    expect(mjpeg).not.toContain('NO VIDEO SIGNAL');

    const live = render({ videoUrl: 'webrtc://mediamtx:8889/cam/whep' });
    expect(live).toContain('<video');
    expect(live).not.toContain('<canvas');

    const rtsp = render({ videoUrl: 'rtsp://192.168.1.42:8554/cam' });
    expect(rtsp).toContain('RTSP source');
    expect(rtsp).not.toContain('<video');
  });

  it('always shows the REC badge', () => {
    expect(render({})).toContain('REC');
    expect(render({ connState: 'connected', videoUrl: 'rtsp://x/y' })).toContain('REC');
  });
});
