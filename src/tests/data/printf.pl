use strict;
use warnings;

sub num_to_two_digit_str {
    my $value = shift;
    return sprintf( "%02d", $value );
}

my $test = 1;

print num_to_two_digit_str($test) . "\n";
