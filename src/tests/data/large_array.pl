use strict;
use warnings;

my @large_array;

for ( my $i = 0 ; $i < 1000000 ; $i++ ) {
    $large_array[$i] = $i;
}

print "Done\n";
