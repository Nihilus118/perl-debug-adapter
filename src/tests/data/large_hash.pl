use strict;
use warnings;

my %large_hash;

for ( my $i = 0 ; $i < 1000000 ; $i++ ) {
    $large_hash{$i} = $i;
}

print "Done\n";
