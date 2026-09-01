import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { POSTER_IMAGE_SIZE } from '@tracearr/shared';
import { MediaCard } from './MediaCard';
import { MediaCardSmall } from './MediaCardSmall';

const POSTER_PARAMS = `width=${POSTER_IMAGE_SIZE.width}&height=${POSTER_IMAGE_SIZE.height}`;

describe('media card posters', () => {
  it('asks MediaCard posters at the one cached size', () => {
    render(
      <MediaCard
        title="The Bear"
        type="movie"
        playCount={3}
        watchTimeHours={2}
        thumbPath="/library/metadata/1/thumb/1"
        serverId="srv-1"
      />
    );

    expect(screen.getByAltText('The Bear')).toHaveAttribute(
      'src',
      expect.stringContaining(POSTER_PARAMS)
    );
  });

  it('asks MediaCardSmall posters at the one cached size', () => {
    render(
      <MediaCardSmall
        title="Arrival"
        type="movie"
        playCount={1}
        thumbPath="/library/metadata/2/thumb/2"
        serverId="srv-1"
      />
    );

    expect(screen.getByAltText('Arrival')).toHaveAttribute(
      'src',
      expect.stringContaining(POSTER_PARAMS)
    );
  });
});
