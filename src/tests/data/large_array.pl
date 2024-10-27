use strict;
use warnings;

my @large_array;

for ( my $i = 0 ; $i < 1000000 ; $i++ ) {
    $large_array[$i] = $i;
}

print $large_array[0] . "\n"; # $large_array[2]
print $large_array[1] . "\n";
# $large_array[1]

print "Done\n";
